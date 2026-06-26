"""MVP package for the ml-sharp Flux repair pipeline."""


def decode_subprocess_output(data: bytes | None) -> str:
    """Decode subprocess stdout/stderr bytes robustly.

    On Chinese Windows the system ANSI code page is GBK (CP936), but the parent
    process may expect UTF-8 (e.g. ``chcp 65001`` in *start.bat* or Windows
    UTF-8 mode).  Subprocesses can therefore emit bytes that are invalid UTF-8,
    causing ``'utf-8' codec can't decode byte …`` crashes.

    This helper tries UTF-8 first, then GBK, then latin-1 (which never fails) so
    that log/error text is always recoverable.
    """
    if not data:
        return ""
    for encoding in ("utf-8", "gbk", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")
