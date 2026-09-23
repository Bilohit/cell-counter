"""Score engine 0 and engine 1 inside one tile's cluster-chunk boxes (the only
GT the two un-annotated tiles have). python -m ml.score_chunks "<tile stem>"
Detections and GT are both clipped to each chunk box; Hungarian at 13.2 px."""
import sys

import cv2
import numpy as np

import pipeline
import score
from ml import data


def main(name):
    bgr = cv2.imread(f"data/tif/{name}.tif", cv2.IMREAD_COLOR)
    chunks = data.load_chunks(name)
    for eng in (0, 1):
        det = np.array(pipeline.count_cells(bgr, {"engine": eng})["centers"], float).reshape(-1, 2)
        tp = fp = fn = 0
        for c in chunks:
            bx, by, bw, bh = c["box"]
            inb = lambda p: (p[:, 0] >= bx) & (p[:, 0] < bx + bw) & (p[:, 1] >= by) & (p[:, 1] < by + bh)
            d, g = det[inb(det)], c["points"][inb(c["points"])]
            m = len(score.match(d, g, 13.2))
            tp, fp, fn = tp + m, fp + len(d) - m, fn + len(g) - m
        f1 = 2 * tp / max(1, 2 * tp + fp + fn)
        print(f"engine {eng}: chunks {len(chunks)} gt {tp + fn} det {tp + fp} tp {tp} fp {fp} fn {fn} "
              f"F1 {f1:.3f} bias {(fp - fn) / len(chunks):+.2f} cells/chunk")


if __name__ == "__main__":
    main(sys.argv[1])
