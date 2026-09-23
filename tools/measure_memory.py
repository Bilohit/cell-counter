"""Peak memory of 1 vs 2 concurrent counts per level -> the RAM floor for 2 slots.

    python tools/measure_memory.py <level> <k>
Run each (level, k) in a fresh process; paste TWO_SLOT_MIN_RAM_GB into app.py.
"""
import ctypes, glob, os, sys, threading
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2, pipeline


def peak_gb():
    if os.name == "nt":
        from ctypes import wintypes as wt
        class PMC(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD)] + [
                (n, ctypes.c_size_t) for n in ("PeakWorkingSetSize", "WorkingSetSize",
                "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
        k32, psapi = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")
        k32.GetCurrentProcess.restype = wt.HANDLE
        # argtypes must be explicit: without it, ctypes marshals the (64-bit,
        # pseudo -1) process handle as a plain int and overflows on 64-bit
        # Windows (2026-09-22, this build). PROCESS_MEMORY_COUNTERS* is the
        # struct pointer; cb (its byte size) is a DWORD.
        psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.POINTER(PMC), wt.DWORD]
        psapi.GetProcessMemoryInfo.restype = wt.BOOL
        m = PMC(); m.cb = ctypes.sizeof(m)
        psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(m), m.cb)
        return m.PeakWorkingSetSize / 1e9
    import resource
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / 1e9 if sys.platform == "darwin" else r / 1e6


if __name__ == "__main__":
    lvl, k = int(sys.argv[1]), int(sys.argv[2])   # run each (level, k) in a fresh process
    im = cv2.imread(sorted(glob.glob("data/tif/*.tif"))[0])
    ts = [threading.Thread(target=pipeline.count_cells, args=(im, {"level": lvl})) for _ in range(k)]
    [t.start() for t in ts]; [t.join() for t in ts]
    print(f"level {lvl} x{k}: peak {peak_gb():.2f} GB")
