# The photo-pigeon probe

Three things about the Google Photos Library API decide how this tool is built,
and none of them can be settled from documentation: the documentation does not
say, and the public reports disagree with each other. `scripts/probe.ts` settles
them by uploading real files to the real API and writing down what came back.

This file is the findings, the evidence behind them, and the instructions for
taking your own measurements if you want to check.

## The three questions

1. **Does Google deduplicate identical bytes?** If the exact same file goes up
   twice, does the library end up with one photo or two?
2. **Does every chunk of a resumable upload cost a request?** The Photos Library
   API allows 10,000 requests per project per day. A large file goes up in
   chunks. Is that one request or one per chunk?
3. **What does a 403 actually mean?** A user brings their own Google
   credentials, something is wrong, and the API answers 403. The public reports
   are a pile of identical 403s with at least four different causes behind them.

## Method

The probe uploads twenty small files whose bytes are all different, then
re-uploads five of them byte for byte under new filenames, then pushes one 25 MB
file up in chunks and counts the HTTP requests it took. Twenty six files in
total, a few kilobytes each apart from the large one.

Every result below was taken against a **published** desktop OAuth client owned
by the account signing in, which is the configuration this product ships people
into. Measured 28 July 2026. Google can change any of this, which is why the
probe is a script and not a paragraph.

Two limits of the method, stated rather than buried:

- **The probe cannot see quota accounting.** It counts requests on the wire. How
  many of those Google charges against the daily allowance exists only in the
  Cloud console, so that half of question 2 is read off the metrics page.
- **The probe cannot delete anything.** The only permission this project ever
  holds is `photoslibrary.appendonly`. Test uploads land in a real library and
  come out by hand, one click each from the links the probe records.

## Findings

### 1. Identical bytes come back as the same media item

**Dedup: YES.** Re-uploading the same bytes under a new filename returned the
media item id of the original. The twenty distinct files produced twenty distinct
ids, so the deduplication is on content and not an artefact of the test file.

The complementary result is worth checking on any re-run: if the first twenty
come back with fewer than twenty ids, Google normalized the files before storing
them, most likely by discarding the random padding the probe uses to make them
unique, and then deduplicated on what was left. That would be a finding about the
synthetic test file rather than about real photos, so re-run with `--sample`
pointed at a real photo before recording it.

### 2. Chunks are not metered against the daily request allowance

A 25 MB file took **26 requests on the wire**: one to open the resumable session
and one per chunk. The Cloud console, read four hours later so lag was not a
factor, showed only the `batchCreate` calls. The upload and chunk requests do not
appear against the 10,000 a day.

### 3. A 403 has four distinguishable causes

All four produce the same status code and none of them says which one it is:

1. The Photos Library API is enabled on a different project than the credentials
   belong to. This is the single most common cause, and it is easy to reach with
   two console tabs open.
2. The consent screen is still in **Testing**, so refresh tokens expire after
   seven days and uploads fail about a week after setup with `invalid_grant`.
3. The account signing in is not the account that owns the project, and the app
   is unpublished.
4. The OAuth client is a **Web application** client where a **Desktop app**
   client is required. A Web client refuses the loopback redirect a desktop tool
   has to use.

The probe run itself produced **zero 403s**, which is what a correctly configured
project looks like. When one does occur, the probe prints a box naming the most
likely cause and the exact console page that fixes it.

## What the product does because of these answers

- **The local sha256 ledger is the primary deduplication**, and Google's
  server-side deduplication is a backstop rather than a substitute. Even with
  dedup on, sending a file to discover Google already has it costs the whole file
  over the wire. The ledger is what makes a rename, a folder reorganisation or a
  restore from backup free.
- **The uploader can use small chunks.** Since chunks are not metered, the
  cheaper trade is small ones: a dropped connection then costs a chunk to
  recover rather than a file.
- **`photo-pigeon doctor` separates the 403 causes by name.** It reports the
  disabled-API case, the publishing-status case and the Web-versus-Desktop client
  case with the console page for each, instead of reporting a status code. The
  wording in the probe's 403 box was the first draft of that.
- **Every user creates their own OAuth client and publishes it.** Publishing is
  free, needs no Google review, and is what stops cause 2.

## One thing no probe can answer

Google labels each OAuth scope as sensitive or restricted, and that label decides
whether a project can be pushed toward the verification review this one is built
to avoid. The API never returns it. It is read by eye on the Data access page:

<https://console.cloud.google.com/auth/scopes>

Look at how `photoslibrary.appendonly` is labelled and record what it says.

---

# Taking your own measurements

About thirty minutes, most of it clicking. You need a Google account you do not
mind putting twenty six tiny test photos into, and about ten minutes in the
Google Cloud console.

## Part one: the Cloud project, five steps

You are making your own private set of Google API credentials. This sounds
heavier than it is. It is free, it takes a few minutes, and it is a thing you do
once. What you get is your own quota that nobody else shares, and an app that
never needs Google's review because it only ever has one user.

Every link below opens the exact page. Once the project exists, note its
**project id** (something like `pigeon-probe-472911`, shown on the project page
and not the same as the display name). Adding `?project=YOUR_PROJECT_ID` to any
of these links skips the project picker.

### Step 1: create the project

<https://console.cloud.google.com/projectcreate>

Name it something recognisable as disposable. `pigeon-probe` is fine. A first
visit to Google Cloud asks you to accept the terms of service first. It does not
ask for a card, and nothing here can charge you.

Copy the project id from the confirmation when it finishes.

### Step 2: enable the Photos Library API

<https://console.cloud.google.com/apis/library/photoslibrary.googleapis.com>

Check the project name in the blue bar at the top is the one you just made, then
press **Enable**. Wait for it to say it is enabled.

This step is cause 1 of the mystery 403. With several Google Cloud tabs open it
is genuinely easy to enable the API on one project and create credentials in
another, and the resulting error message does not tell you that is what happened.

### Step 3: set up the consent screen, audience External

<https://console.cloud.google.com/auth/overview>

Google calls this area **Google Auth Platform**. Press **Get started** and fill
in:

- **App name**: anything, but it cannot contain the word Google. Google rejects
  the registration if it does, without explaining why. `photo-pigeon probe`
  works.
- **User support email**: pick your own address from the list.
- **Audience**: choose **External**. Internal is only offered to Workspace
  accounts and would limit this to one organisation.
- **Contact information**: your own address again.

Agree to the policy and press Create.

The **Get started** button lives on this overview page, which is why the link
above is `/auth/overview` and not `/auth/branding`. Branding is where the same
app name and support email live once the app exists, so it is the page to come
back to for edits rather than the one to begin on.

Two steps that nearly every tutorial includes here, and that you should skip:

- **Do not add scopes.** The scope list on the Data access page only matters for
  Google's verification review, which this setup never asks for. The scope the
  app actually gets is the one the code requests at sign in time.
- **Do not add test users.** Step 4 makes the idea of test users moot.

### Step 4: publish the app

<https://console.cloud.google.com/auth/audience>

Find **Publishing status**, press **Publish app**, and confirm.

This is the most important click in the setup and the one most often missed. An
app left in **Testing** hands out refresh tokens that expire after seven days,
every time, forever. Uploads work for a week, then one morning everything fails
with `invalid_grant` and nothing changed to cause it. That is cause 2, and public
issue threads have been arguing about it since 2023.

Publishing costs nothing and needs no review. The app becomes an unverified
production app, which means anyone signing in sees one screen saying "Google
hasn't verified this app". Click **Advanced**, then **Continue**, once. In
exchange the credentials work indefinitely.

### Step 5: create a Desktop OAuth client and download the JSON

<https://console.cloud.google.com/auth/clients>

Older console layout, if that link lands somewhere unfamiliar:
<https://console.cloud.google.com/apis/credentials>

Press **Create client**, and for **Application type** choose **Desktop app**.
This matters: a Web application client refuses the local redirect the probe uses,
and the error it gives is not obvious. That is cause 4. Name it anything and
press Create.

A dialogue appears with the client id and secret. **Press Download JSON.** The
secret is only shown this once: Google stopped letting you read it later at the
end of 2025. Losing it means making a new client, and a new client id is a
different application as far as Google Photos is concerned, with no history.

The file lands in your Downloads folder as `client_secret_something.json`. It is
a password. `.gitignore` here refuses `client_secret*.json` on purpose, but the
safest place for it is outside the repository entirely.

## Part two: run it

The script path is relative, so `cd` into the repository first. Running the
command from anywhere else fails with `ERR_MODULE_NOT_FOUND`, because Node looks
for `scripts\probe.ts` under whatever folder it was started in.

```
cd <path-to-this-repo>
npx tsx scripts/probe.ts --credentials "C:\Users\you\Downloads\client_secret_xxx.json"
```

The credentials JSON itself can live anywhere. Quote its full path after
`--credentials`.

A browser window opens asking you to sign in and grant access. Sign in with the
account whose Google Photos library you are willing to put test files into. Two
things to expect on that screen:

- **"Google hasn't verified this app"**, for exactly the reason step 4 gives.
  Click **Advanced**, then **Continue to ...**.
- **A tickbox for the Google Photos permission.** Google presents it as optional.
  It is not optional here. Leaving it unticked produces a 403 about insufficient
  scopes some minutes later, a long way from the cause.

Then it runs and prints as it goes: two or three minutes, most of it the large
file.

| Flag | Why you would use it |
|---|---|
| `--sample <path to a real photo>` | The probe builds its test files from a tiny synthetic JPEG. If uploads come back rejected, point this at a real photo to rule the synthetic file out. |
| `--large <path to a real big file>` | The generated large file is a small picture padded out to 25 MB. It measures the transport honestly but it is not a real photo. Point this at an actual large photo or a video for a result you can quote. |
| `--skip-large` | Skip the chunk test. Halves the runtime. |
| `--chunk-kb 256` | Force smaller chunks, so the chunk count goes up and the quota question gets a sharper answer. |
| `--keep` | Keep the generated test files on disk instead of deleting them. |
| `--help` | The full list. |

Nothing in the probe deletes or modifies anything in Google Photos, and nothing
in it ever can. The only permission it holds is append.

## Part three: reading your own results

The probe prints a summary block at the end and writes the full detail to
`probe-results.json` in the repository root, which git ignores.

**DEDUP: YES or NO** is the headline, and it is the answer to question 1.
**YES** means the five re-uploads came back carrying the same media item ids as
the originals. **NO** means they became five new photos. Underneath it, the count
of **distinct ids** from the first twenty should be twenty.

**The chunk count** is exact, because the probe counted the requests. For the
quota half of question 2, the summary prints a direct link to the metrics page
for your project. Open it, set the window to the last hour, and compare:

- Console count close to the probe's total: **each chunk costs quota.** Large
  files want large chunks, and the daily ceiling is closer than naive arithmetic
  suggests.
- Console count far lower: **chunks are effectively free.** Small chunks are the
  better trade, because a dropped connection becomes cheap to recover from.

Metrics can lag by a few minutes. If the page looks empty, wait and refresh.

**The 403 box**, if one appears, names the most likely of the four causes and
gives the exact page to fix it on. A case it gets wrong is worth more than a
clean run: report it.

## Afterwards

Delete the test items if you want them gone. `probe-results.json` has a
`productUrl` for every one, which opens it directly in Google Photos. It is one
click each. photo-pigeon will not do this for you, now or ever, because it holds
no permission that could.

Two files the run leaves on disk, both ignored by git and neither safe to share:

- `.photo-pigeon/probe-token.json`, holding a live refresh token for your
  account. It is reused on the next run so you do not have to consent again.
  Delete it to force a fresh sign in, or when you are done.
- `probe-results.json`, the full record. It never contains your client secret or
  any token, and the client id in it is masked, but it does list your project id
  and links into your photo library.

To remove the throwaway project entirely:
<https://console.cloud.google.com/iam-admin/settings>

Worth knowing either way: an OAuth client that goes six months without being used
is deleted automatically, with thirty days notice by email. That is a real hazard
for anyone who backs up seasonally, and `photo-pigeon doctor` warns about it.
