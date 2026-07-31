# Privacy

What this program moves, where it moves it, and what it keeps. Short, because
there is not much of it.

## Nothing leaves your machine until you have set it up

Installing changes nothing about your data. Until the setup wizard has finished
and you have named a folder to watch, no file is read for delivery, no network
request carries anything of yours, and no credential exists. Quitting or
uninstalling before that point leaves nothing behind to opt out of.

That is the opt-out: the program does nothing until it is told what to do, and it
is told once, by you, on a screen that says what will happen.

## What is transferred, and to whom

**Your photos, to your own Google Photos library, and nowhere else.** A file that
lands in a watched folder is uploaded to the Google account you signed into
during setup. There is no server belonging to this project, no account with us,
and no third party in the path. The connection is to Google's own API.

**Nothing else is transferred at all.** No telemetry, no usage statistics, no
crash reports, no file names, no counts, no ping on launch.

There is one network request that carries nothing of yours: once a day the
program asks this project's GitHub release page whether a newer version exists.
It sends no identifier. It can be turned off by setting
`PHOTO_PIGEON_UPDATE_CHECK=off`.

## What is stored, and where

Everything the program keeps lives in `~/.photo-pigeon` on your own machine:

- **Your Google credentials and access token.** They are yours, from your own
  Google Cloud project, and they never leave the machine except to talk to
  Google.
- **The delivery record**, `ledger.jsonl`: the sha256 of each delivered file, so
  nothing is uploaded twice. It is a list of hashes and names, not copies.
- **Your configuration**: which folders are watched, and your choices.

Uninstalling deliberately leaves that directory alone, so a reinstall does not
re-upload your library. Deleting it by hand is the complete removal, and the
uninstaller offers to do it for you if you answer yes to the application data
question.

## What it cannot do

The only permission requested from Google is `photoslibrary.appendonly`, which
can add photos and nothing else. It cannot read, delete, move or change anything
already in your library, and no future version will ask for more.

## Questions

Open an issue at
[github.com/justerlex/photo-pigeon/issues](https://github.com/justerlex/photo-pigeon/issues).
