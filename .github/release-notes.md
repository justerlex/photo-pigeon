<!--
  The body every draft release is created with.

  release.yml feeds this file to `gh release create --notes-file`, and the
  release is a draft, so this is a starting point a person edits rather than the
  final page. One thing belongs on the published page and cannot come from here:
  what actually changed in this version.

  The drawing is the README's own, read over a raw URL because a release body
  cannot use a relative path, and it renders only once the repository is public.
  Step 7.1 of docs/RELEASE.md makes it public before the publish in 7.2, so the
  draft is worth one look in between: if the picture is not there, the two clicks
  are still in words above it and the line can go.

  The words are the README's words, because a user meeting the wall on this page
  should not have to go and find them.
-->

Watches your folders, delivers every new photo to Google Photos.

## Install on Windows

Download the `.exe` below and run it. It installs for the current user only, into
`%LOCALAPPDATA%\Photo Pigeon`, and asks for no administrator rights.

**Windows will stop you the first time, and here is what to click.** You get a
blue box saying "Windows protected your PC", with **Unknown publisher**
underneath and no Run button on it. In order:

1. **More info**
2. **Run anyway**

<p align="center">
  <img src="https://raw.githubusercontent.com/justerlex/photo-pigeon/main/docs/art/smartscreen.svg" width="360" alt="A diagram of the Windows SmartScreen box: More info first, then Run anyway" />
</p>

Windows flags every unknown publisher whatever the program does. This one is
unsigned because a certificate costs money every year and this is a free tool.
SignPath Foundation gives certificates to open source projects and an
application goes in with this release, which softens the warning as downloads
accumulate rather than removing it overnight. Worth saying plainly rather than
hiding, because the program is about to ask for access to your photo library.

It keeps itself up to date. Once a day it asks this page whether there is a newer
version, downloads it quietly if there is, and installs it when you next quit the
app, never over a photo on its way out. The tray's Quit item says so while an
update is waiting.

## What it does, and what it cannot do

Point it at a folder. Anything new that lands there is delivered to Google Photos,
and it keeps a record so nothing is sent twice.

**Upload only, by design.** The permission it asks Google for can add photos and
nothing else. There is no code path in it that can delete, move or change anything
already in your library, and there never will be.

> Uploads are original quality and count against your Google storage. Storage Saver does not apply.

Uninstalling leaves your delivery record alone. It lives in `~/.photo-pigeon`,
outside everything the uninstaller touches, so reinstalling later does not
re-upload your library.

## If you would rather use a terminal

The same tool is on npm and needs no installer:

```
npx photo-pigeon setup
```
