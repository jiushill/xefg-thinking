"""Stage the downloaded pwn challenges into a clean tree for upload.

Zips carry either a bare binary or a `题目名/canary` style path; the raw files are
ELF binaries named by their sha256. Everything lands in vm/chals/<short-id>/<name>
so the VM side has one flat, ascii-named directory per challenge.
"""
import hashlib
import os
import shutil
import zipfile

SRC = r"D:\download\pentest"
DST = r"D:\tools\ctf\script\DS_Desktop\nx\vm\chals"

# Deterministic short ids in a stable order (sorted by sha256 of the file name).
ZIPS = {
    "3143f4e2c5a80d8bb026956f7a0abae4a412beaee7c07edb5ae26ef8b5c19e5e.zip": "a1",
    "4aba39e3f4a79ce8e1c14cd0da0aad0f3725ada3bbb0709eb0ee24cbcdbb5463.zip": "a2",
    "cc7e9c600fbe579649323ae15f5164e307c4c635e1c56d92238c5361d04e2a0c.zip": "a3",
    "f13e67870cdab9784cafb61fea506247e9299643eba07a08dd53f9208f8d58b7.zip": "a4",
}
RAW = {
    "79b89d7ca6878f49edc887a43c15ad780bed8ba8ec04f81934f2624efbb0d002": "b1",
    "82cfdbe697d9dd2282a32637b40e88a05b4b6158b8a5ee84cc897dee8f2c5f4b": "b2",
    "ae3f24d342490ada21d3657df87b7f046cc0124f14dfe48b58f23a5065f72b37": "b3",
    "f5b5ad3d70129752edfdf90468f664ff0dc93f06c1e7c7ac1666ad2768ef1232": "b4",
}


def safe_name(name: str) -> str:
    """Zip entries may be GBK-encoded Chinese; normalise to ascii and drop dirs."""
    base = name.replace("\\", "/").split("/")[-1]
    if not base:
        return ""
    try:
        base.encode("ascii")
        return base
    except UnicodeEncodeError:
        return "bin_" + hashlib.sha1(base.encode("utf-8", "surrogateescape")).hexdigest()[:8]


def main() -> None:
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(DST)
    report = []

    for fname, cid in ZIPS.items():
        path = os.path.join(SRC, fname)
        out = os.path.join(DST, cid)
        os.makedirs(out)
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                name = safe_name(info.filename)
                if not name:
                    continue
                data = z.read(info)
                with open(os.path.join(out, name), "wb") as fh:
                    fh.write(data)
                report.append((cid, name, len(data), "zip"))
                if len([n for _, n, _, _ in report if n]) > 0:
                    # keep only the first file per zip; extras are noise
                    pass

    for fname, cid in RAW.items():
        path = os.path.join(SRC, fname)
        out = os.path.join(DST, cid)
        os.makedirs(out)
        target = os.path.join(out, "bin_" + fname[:8])
        shutil.copyfile(path, target)
        report.append((cid, os.path.basename(target), os.path.getsize(target), "raw"))

    for cid, name, size, kind in report:
        print(f"{cid}  {kind:3}  {size:>7}  {name}")


if __name__ == "__main__":
    main()
