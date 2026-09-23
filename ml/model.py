"""U-Net heatmap model for cell detection, and ONNX export."""
import torch
import torch.nn as nn
import torch.nn.functional as F

__all__ = ["UNet", "export_onnx"]


def _conv_block(in_ch, out_ch):
    return nn.Sequential(
        nn.Conv2d(in_ch, out_ch, 3, padding=1), nn.BatchNorm2d(out_ch), nn.ReLU(inplace=True),
        nn.Conv2d(out_ch, out_ch, 3, padding=1), nn.BatchNorm2d(out_ch), nn.ReLU(inplace=True),
    )


class UNet(nn.Module):
    """U-Net heatmap regressor. `levels` encoder stages of base, base*2, ... and
    a bottleneck of base*2**levels, bilinear decoder.

    Default 3 levels / base 16 is the shipped shape: 16/32/64 encoder, 128
    bottleneck, 489k parameters. `levels=4` was added 2026-09-14 to test whether
    a wider receptive field lets the network see clump context on its own -
    crowding is the measured failure mode, and a 3-level net at 22 px cells has
    plenty of resolution but little context (plan 2026-09-14, model question).
    """

    def __init__(self, in_ch, base=16, levels=3):
        super().__init__()
        self.levels = levels
        chans = [base * 2 ** i for i in range(levels)]
        self.enc = nn.ModuleList(
            [_conv_block(in_ch if i == 0 else chans[i - 1], c) for i, c in enumerate(chans)])
        self.pool = nn.MaxPool2d(2)
        self.bottleneck = _conv_block(chans[-1], base * 2 ** levels)

        self.up = nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False)
        dec = []
        below = base * 2 ** levels
        for c in reversed(chans):
            dec.append(_conv_block(below + c, c))
            below = c
        self.dec = nn.ModuleList(dec)

        self.head = nn.Conv2d(base, 1, 1)

    def forward(self, x):
        _, _, h, w = x.shape
        m = 2 ** self.levels
        pad_h = (m - h % m) % m
        pad_w = (m - w % m) % m
        if pad_h or pad_w:
            x = F.pad(x, (0, pad_w, 0, pad_h))

        skips = []
        for i, enc in enumerate(self.enc):
            x = enc(x if i == 0 else self.pool(x))
            skips.append(x)
        x = self.bottleneck(self.pool(x))

        for dec, skip in zip(self.dec, reversed(skips)):
            x = dec(torch.cat([self.up(x), skip], dim=1))

        y = torch.sigmoid(self.head(x))
        return y[:, :, :h, :w]


def export_onnx(model, in_ch, path):
    """Export `model` to ONNX at `path`. Dynamic H/W, opset 17, input "x", output "heat"."""
    model.eval()
    dummy = torch.zeros(1, in_ch, 64, 64)
    torch.onnx.export(
        model, dummy, path,
        input_names=["x"], output_names=["heat"],
        dynamic_axes={"x": {0: "batch", 2: "height", 3: "width"},
                      "heat": {0: "batch", 2: "height", 3: "width"}},
        opset_version=17, dynamo=False,
    )
