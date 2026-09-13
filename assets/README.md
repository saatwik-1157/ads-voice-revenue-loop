# Approved asset library

Drop cleared artwork here as PNG or JPEG and the system uses it instead of the
generated fallback. "Cleared" is the operative word: a person made this artwork,
owns or licensed it, and is happy for it to run against a real budget.

Selection is deliberate rather than arbitrary:

- A filename that names an angle serves that angle — `speed-01.png` is used for
  the "Speed" creative variants. Matching ignores case and punctuation.
- Anything unmatched is drawn from the general pool in a stable order, so a
  given variant keeps the same image across republishes.

Constraints, checked from the file header before anything is uploaded:

- PNG or JPEG (the extension is not trusted; the bytes are read)
- at least 600x600
- at most 8MB

For Reels placements Meta wants 1080x1920 (9:16). Smaller images pass the check
here but will look poor in-feed.

While this directory holds no images, `RenderedAssetProvider` generates plain
text cards instead so the loop stays runnable. Gate #1 tells the approver which
of the two produced the artwork they are approving.
