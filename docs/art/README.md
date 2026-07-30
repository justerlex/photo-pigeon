# The art the README uses

Three drawings and one bird, and none of it is a photograph of anybody's product.
This replaces the capture checklist that used to live in `docs/captures/`: the
mockups the setup window already ships are stylistically right, and a real
screenshot of Windows goes stale the day Microsoft ships a redesign.

| File | Where it came from | Where the README uses it |
|---|---|---|
| `smartscreen.svg` | the welcome screen in `app/ui/setup.html` | the install section, under the two clicks |
| `google-unverified.svg` | the walk screen in `app/ui/setup.html` | first run |
| `tray-overflow.svg` | the finish screen in `app/ui/setup.html` | first run, the bird nobody can find |

The mascot is not here. It lives at `app/ui/pigeon-mascot.png`, because the setup
window ships it, and the README points at that one file rather than keeping a
second copy to forget.

## Two rules

**`app/ui` is the original and this directory is the copy.** Each file here is
the same geometry as the `<svg>` it came out of, with the classes in
`app/ui/pigeon.css` resolved into attributes so the file stands on its own inside
a README, and a caption of its own where the page had a `<figcaption>`. To change
a drawing, change it in `app/ui/setup.html` first and bring it back here. The
window is the surface a user actually meets.

**Drawings, and a drawing says so.** Every file here carries "A diagram, not a
screenshot of Windows" or the same line about Google. A redrawn dialog that does
not admit to being redrawn is a small forgery, and that is what the old capture
rules were written to prevent. The rule survived its own checklist.

The three commented capture slots inside `app/ui/setup.html` are a separate
question and are untouched: they belong to the window rather than to this page,
and `ui-pages.test.ts` still counts them.

The prose in these files is swept for house style along with the documents, which
is written down once in `CONTRIBUTING.md`.
