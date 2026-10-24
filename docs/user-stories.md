# User stories

Two products live in this repo:

1. **RVC Holdings site** (`index.html`): a one-page portfolio for the holding company, which the owner edits in the browser.
2. **ReelScribe** (`captions/`): a browser tool that captions, trims, translates and dubs short videos.

Each story says who wants what and why, then gives acceptance criteria you can test as pass or fail. A **Status** line says whether the code already does it (**Shipped**), with the line that does it, or whether it is a **Gap** found while reading the code.

Verified against `claude/gstack-setup-jykcgc` on 2026-10-24.

## Who uses these

| Persona | Real-world example |
|---|---|
| **Owner** | Ravi, who runs RVC Holdings and updates the site after closing a deal, for example adding a gas station bought in Collingwood under Energy Retail. |
| **Visitor** | A business broker in Ontario with a motel listing, checking whether RVC is a serious buyer before sending it over. |
| **Creator** | Someone who films a 60-second Reel in Hindi on their phone and wants burned-in captions, an English version and a ready-to-paste post caption. |

---

# Part 1: RVC Holdings site

## Epic A: Visitors understand the business

### A1. Scan the portfolio at a glance
**As a** visitor, **I want** to see every vertical with a code, a name and a one-line summary, **so that** I can tell within seconds whether my deal fits.

*Example:* a broker with a fuel station sees `FUEL · Energy Retail · Gas stations and convenience stores, bought on verified numbers.` and knows to reach out.

Acceptance criteria:
1. Given the published content has 8 verticals, the Portfolio header shows "Eight verticals" (`index.html:409-413`). For counts above 12 it shows the number, e.g. "13 verticals".
2. Each row shows its code, name and one-line summary, plus a count such as "2 holdings" when it has assets. The count is hidden when it has none (`index.html:457-458`).
3. With zero verticals the board shows "No verticals listed." (`index.html:429-435`).

**Status:** Shipped.

### A2. Read the thesis for one vertical
**As a** visitor, **I want** to expand a vertical to read its thesis, approach and named holdings, **so that** I know how the operator thinks before I make contact.

Acceptance criteria:
1. Clicking a row toggles it open or closed, and `aria-expanded` matches the state (`index.html:451`, `507-513`).
2. An open row shows Thesis and Approach, and a Holdings list only when assets exist (`index.html:443-449`).
3. When printed, every row is expanded and the edit controls are hidden (`index.html:167-171`).
4. With "reduce motion" turned on in the OS, rows appear without the slide-in animation (`index.html:163-166`).

**Status:** Shipped.

### A3. Know who is behind it and how to reach them
**As a** visitor, **I want** the operator's background and contact details on the same page, **so that** I can judge credibility and email without hunting.

Acceptance criteria:
1. The Operator section shows every paragraph in the content's `operator` list, in order (`index.html:477-481`).
2. The Contact section shows email, location and "Open to" text (`index.html:213-220`).
3. **Gap:** the email is plain text, not a `mailto:` link, so on a phone the visitor has to copy it by hand. Make it a tappable link that opens the mail app with the address filled in.

**Status:** Shipped, except the email link (Gap).

### A4. Find the captions tool
**As a** visitor or the owner, **I want** a link from the main site to ReelScribe, **so that** the tool at `/captions/` can be found without knowing the URL.

Acceptance criteria:
1. The main page links to `captions/`, in the footer or the Operator section.

**Status:** Gap. `index.html` has no link to `captions/` today.

## Epic B: The owner edits content without touching code

### B1. Unlock editing privately
**As the** owner, **I want** to unlock the edit controls by opening a secret link, **so that** visitors never see them.

Acceptance criteria:
1. Visiting `/#<edit word>` shows the "Edit content" button and the toast "Editing unlocked", then removes the word from the address bar (`index.html:331-345`).
2. The unlock is remembered on that device across reloads (`index.html:312-314`, `344`).
3. Visitors who don't use the link never see the button (`index.html:181`, which renders it `hidden`).
4. **Gap, security:** the edit word is written in the page source (`index.html:297`), so anyone who opens View Source can unlock editing. The harm is small because edits only change that person's own browser (B3), but the comment calling it "private" is misleading. Either reword the comment to say it hides the controls but doesn't protect anything, or check a hash of the word instead of the word itself.

**Status:** Shipped. Criterion 4 is a Gap.

### B2. Edit any text in place
**As the** owner, **I want** to click any headline, paragraph or contact field and type, **so that** fixing a typo takes seconds.

*Example:* changing "Collingwood, Ontario" to "Toronto, Ontario" after a move.

Acceptance criteria:
1. In edit mode every text field can be edited and has spellcheck on (`index.html:482-493`).
2. Pressing Enter finishes the edit and doesn't add a new line (`index.html:501-506`).
3. An empty field shows grey placeholder text, e.g. "City, Country" (`index.html:132`).
4. Typing saves a draft 700 ms after the last keystroke (`index.html:373`, `495-500`).

**Status:** Shipped.

### B3. Keep a draft safe until publishing
**As the** owner, **I want** edits to survive a reload on my device without appearing to visitors, **so that** I can work on an update over a few days.

Acceptance criteria:
1. The edit bar says "Unpublished draft on this device" when a draft exists, otherwise "Matches published site" (`index.html:374-377`).
2. A draft that won't load (corrupted or missing data) falls back to the published content, and the page still opens (`index.html:347-362`).
3. If the browser refuses to save, the toast says "Could not save draft" (`index.html:369-371`).
4. "Discard my edits" asks for confirmation, then restores the published content (`index.html:565-573`).

**Status:** Shipped.

### B4. Manage verticals
**As the** owner, **I want** to add, reorder and remove verticals, **so that** the portfolio matches the business as it changes.

*Example:* adding a "Logistics" vertical and moving it above Hospitality.

Acceptance criteria:
1. "+ Add vertical" adds a row coded `NEW` named "New vertical" (`index.html:556-560`).
2. "↑ Up" on the first row and "↓ Down" on the last row do nothing (`index.html:529-537`).
3. "Remove vertical" asks `Remove "<name>" from the portfolio?` and removes the row only if confirmed (`index.html:538-546`).
4. In edit mode every row is expanded, so all fields can be edited (`index.html:438`).

**Status:** Shipped.

### B5. Record an acquisition under a vertical
**As the** owner, **I want** to add a named property with a note and year under a vertical, **so that** the site shows a real track record, not just a thesis.

*Example:* under FUEL, add "Esso + c-store, Hwy 26 · 0.9 acres · 2026".

Acceptance criteria:
1. "+ Add property" adds an empty asset with name, note and year fields (`index.html:515-521`).
2. "Remove" on an asset deletes it right away, without asking (`index.html:522-528`).
3. A vertical with no assets shows "Nothing added yet…" in edit mode and nothing to visitors (`index.html:445`).

**Status:** Shipped. Removing an asset without confirmation is a deliberate choice: an asset is quick to re-add, unlike a whole vertical.

### B6. Publish the update
**As the** owner, **I want** to download a finished `index.html` with my edits built in, **so that** I can upload it to GitHub and make it live.

Acceptance criteria:
1. "Download site file" saves a file named `index.html` whose embedded content equals the current draft (`index.html:575-598`).
2. The downloaded file opens in visitor mode: no `editing` class, no editable fields, Edit button hidden (`index.html:579-589`).
3. Opening the downloaded file with no saved draft shows exactly what the owner saw when they downloaded it.
4. **Gap:** after downloading, the toast says only "Downloaded index.html". Add a one-line next step, e.g. "Upload it to the repo on GitHub to go live", because a downloaded file alone doesn't change the live site.

**Status:** Shipped. Criterion 4 is a Gap.

### B7. Lock editing on a shared device
**As the** owner, **I want** to hide the edit controls again, **so that** someone else using this laptop doesn't see them.

Acceptance criteria:
1. "Lock editing" asks for confirmation, then hides the controls and shows the toast "Editing locked" (`index.html:561-564`, `319-330`).
2. Locking leaves the draft in place, and the next unlock picks it up again.

**Status:** Shipped.

---

# Part 2: ReelScribe (`captions/`)

## Epic C: Get a video in

### C1. Load a video from phone or desktop
**As a** creator, **I want** to drop or pick a video, **so that** I can start in one step.

Acceptance criteria:
1. Dropping a file or using "Choose video" loads it. A file that isn't a video shows "Please choose a video file." (`captions/app.js:560-565`, `1326-1337`).
2. A video format the browser can't play shows "This browser can't play that video format. Try MP4 or WebM." (`captions/app.js:583`).
3. Loading a new video clears captions, translation, dub, keywords and every status line from the last one (`captions/app.js:566-579`).
4. "New video" and drag-and-drop do nothing while an export or audio read is running (`captions/app.js:561`, `1339`).
5. The video never leaves the device. Only the speech model is downloaded (`captions/index.html:145`).

**Status:** Shipped.

### C2. Read audio from any phone format
**As a** creator filming on an iPhone, **I want** captions to work on `.mov` files and long clips, **so that** I don't have to convert the file first.

Acceptance criteria:
1. Files up to 60 MB on a phone (500 MB on a computer) are decoded straight away in the background (`captions/app.js:12`, `609-637`).
2. Larger files, or files whose quick decode fails or takes too long, fall back to playing the video silently and recording its audio, with a progress line like "Reading audio… 0:42 / 1:30" (`captions/app.js:658-727`).
3. A video with no sound shows "This video seems to have no sound." (`captions/app.js:721`).
4. Leaving the tab during the silent playback stops it with "keep this tab open and try again." (`captions/app.js:685`).

**Status:** Shipped.

## Epic D: Captions

### D1. Generate word-timed captions on the device
**As a** creator, **I want** captions generated in my browser with each word timed, **so that** words light up exactly as I say them.

Acceptance criteria:
1. "Generate captions" downloads the model once with "Downloading speech model… X / Y MB", then shows "Transcribing on GPU…" or "on CPU…" (`captions/app.js:771-787`, `captions/transcribe-worker.js:33-42`).
2. On success it shows "N words transcribed.", or "No speech found." if nothing was heard, and the button becomes "Regenerate captions" (`captions/app.js:797-799`).
3. The spoken language can be auto-detected or chosen from 10 options (`captions/index.html:177-191`).
4. Phones default to the Fast (tiny) model and never use the GPU (`captions/app.js:817`, `1399-1402`).
5. If the phone ran out of memory and reloaded the page, the next visit explains why and suggests Fast plus a clip under 2 minutes (`captions/app.js:1403-1408`).

**Status:** Shipped.

### D2. Import existing subtitles
**As a** creator who already has an `.srt` file from an editor, **I want** to import it instead of re-transcribing, **so that** I can reuse captions I've already fixed.

Acceptance criteria:
1. Importing `.srt` or `.vtt` replaces the words and shows "Imported N words." (`captions/app.js:1343-1354`).
2. Formatting tags like `<i>` are stripped, and blocks with bad timings are skipped (`captions/app.js:836-852`).
3. A file with no usable blocks shows "No captions found in that file."

**Status:** Shipped.

### D3. Style captions to match my brand
**As a** creator, **I want** presets plus control over font, size, position, colours and words per caption, **so that** my Reels look consistent.

Acceptance criteria:
1. Six presets (Pop, Karaoke, Box, Neon, Minimal, Bold) set font, case and colours in one tap (`captions/app.js:37-44`, `1259-1270`).
2. Words per caption runs from 1 to 8. A caption also breaks at punctuation, at a gap over 0.7 s, or past 32 characters (`captions/app.js:252-268`).
3. Each caption stays on screen up to 0.6 s after its last word, without overlapping the next (`captions/app.js:270-273`).
4. Frame options Original, 9:16, 1:1, 4:5 and 16:9 crop from the centre (`captions/index.html:235-242`).

**Status:** Shipped.

## Epic E: Trim by editing words

### E1. Cut dead air automatically
**As a** creator, **I want** silences removed, **so that** a rambling 90-second take becomes a tight 60 seconds.

Acceptance criteria:
1. With "Remove silences" on, any pause longer than the minimum (0.2 to 2.0 s, default 0.5) is cut, leaving 0.12 s of breathing room at each edge (`captions/app.js:159-192`).
2. The status line shows "Cutting X.Xs — new length M:SS." (`captions/app.js:200-203`).
3. Silence is judged relative to the loudest parts of this recording, so it adapts to quiet and loud clips (`captions/app.js:171-174`).

**Status:** Shipped.

### E2. Remove filler words
**As a** creator, **I want** "um", "uh" and similar removed, **so that** I sound sharper without re-recording.

Acceptance criteria:
1. 12 filler words are recognised (`captions/app.js:31`). They show in orange in the transcript and are struck through when removal is on (`captions/app.js:868-869`).
2. Turning on "Remove filler words" cuts them from the video and the captions.
3. **Gap:** the post kit sends the transcript with fillers still in (`captions/app.js:977`), while translation leaves them out (`captions/app.js:950`). Leave fillers out of the post kit too, so its keywords never include "um".

**Status:** Shipped. Criterion 3 is a Gap.

### E3. Edit the transcript to edit the video
**As a** creator, **I want** to click words to jump to them, cut them, or fix their spelling, **so that** editing feels like editing a document.

Acceptance criteria:
1. **Seek** mode: clicking a word jumps playback to that word (`captions/app.js:896-897`).
2. **Cut** mode: clicking a word toggles a strike-through and removes or restores that stretch of video (`captions/app.js:898-900`).
3. **Edit text** mode: Enter saves the corrected word. Clearing a word completely cuts it (`captions/app.js:901-919`).
4. The word being spoken is highlighted during playback (`captions/app.js:877-890`).

**Status:** Shipped.

## Epic F: AI features (bring your own key)

### F1. Add my own API keys
**As a** creator, **I want** to paste my Anthropic and ElevenLabs keys once, **so that** AI features work without an account on this site.

Acceptance criteria:
1. Keys are saved only in this browser and sent only to their own provider. The dialog warns to use keys with spending limits (`captions/index.html:341`).
2. Using an AI feature without its key opens Settings with "Add your <provider> key in Settings first." (`captions/app.js:936-941`).
3. If the browser refuses to store them, the toast says they'll last only until the tab closes (`captions/app.js:83`).
4. A rejected key, a rate limit, or a busy provider each get a plain-English message (`captions/ai.js:41-47`).

**Status:** Shipped.

### F2. Translate captions
**As a** creator posting in Hindi, **I want** English captions with the same timing, **so that** the same Reel reaches a wider audience.

Acceptance criteria:
1. 22 target languages, including 9 Indian languages (`captions/app.js:32-36`).
2. The translated text is spread across the time the original sentence took. Languages written without spaces, like Chinese and Japanese, show 4 characters at a time (`captions/app.js:235-249`).
3. An Original / Translated switch changes which captions are shown, without translating again (`captions/app.js:1299-1305`).
4. A new translation discards any existing dub, because the dub no longer matches the captions (`captions/app.js:954-957`).

**Status:** Shipped.

### F3. Dub the video in another voice
**As a** creator, **I want** the translated captions spoken by an AI voice and timed to the video, **so that** viewers can listen, not just read.

Acceptance criteria:
1. Lines are generated 3 at a time, with progress shown as "Generating voice… n / N" (`captions/app.js:1041-1055`).
2. A line longer than its slot is sped up, by 35% at most, and the status reports how many lines were sped up (`captions/app.js:1065`, `1079-1081`).
3. The original audio volume when dubbed defaults to 12%, and "Use dubbed audio" switches the dub on or off (`captions/index.html:294`, `captions/app.js:1306-1311`).

**Status:** Shipped.

### F4. Get a ready-to-post kit
**As a** creator, **I want** a title, hook, description and hashtags written from my transcript, **so that** I can post right after exporting.

Acceptance criteria:
1. Returns a title under 70 characters, a 3-second hook, a 2-3 sentence description, 5-8 hashtags and 4-10 keywords (`captions/ai.js:100-105`).
2. Each card has a Copy button that confirms with "Copied." (`captions/app.js:1001-1004`).
3. The keywords are highlighted in the captions using the Keywords colour (`captions/app.js:979-981`).

**Status:** Shipped.

## Epic G: Get it out

### G1. Export a video ready to upload
**As a** creator, **I want** to export the edited video with captions burned in, **so that** I can upload it straight to Instagram, TikTok or YouTube.

Acceptance criteria:
1. Export prefers H.264 MP4 and falls back to WebM (`captions/app.js:1095-1105`). The file is named `reelscribe-<timestamp>.mp4` or `.webm`, with its size on the download button.
2. A WebM export, or an MP4 without H.264, comes with a note on which platforms may reject it (`captions/app.js:1188-1192`).
3. If everything has been cut, export shows "Everything is cut — nothing to export." (`captions/app.js:1113-1115`).
4. Closing the tab during an export triggers the browser's "Leave site?" warning (`captions/app.js:1395-1397`).
5. Quality choices: Standard 4, High 8 (the default), Max 14 Mbps (`captions/index.html:318-322`).

**Status:** Shipped. Export records in real time, so a 60-second edit takes about 60 seconds to export. That is a known limit, explained in the hint at `captions/index.html:327`.

### G2. Download subtitles that match the edit
**As a** creator, **I want** an `.srt` whose timings match the trimmed video, **so that** YouTube shows captions in sync.

Acceptance criteria:
1. Every caption's time is moved earlier by the total length cut before it (`captions/app.js:1209-1210`).
2. The file is named `captions.srt` and uses `HH:MM:SS,mmm` timestamps (`captions/app.js:1202-1216`).
3. It follows the language currently showing, Original or Translated.

**Status:** Shipped.

---

## Gaps found, in priority order

| # | Story | Gap | Why this priority | Effort |
|---|---|---|---|---|
| 1 | B1.4 | Edit word visible in page source (`index.html:297`) | The comment promises privacy the code doesn't give. Low harm (edits are local only), but misleading. | ~15 min |
| 2 | B6.4 | No "upload to go live" hint after download | Without it the owner may think the live site already changed. | ~5 min |
| 3 | A3.3 | Email not a `mailto:` link | Brokers mostly visit on phones, and copying an address by hand loses some of them. | ~10 min |
| 4 | E2.3 | Post kit includes filler words | Keywords could include "um". Small inconsistency with translation. | ~5 min |
| 5 | A4 | No link from the site to `/captions/` | Nobody can find the tool without knowing the URL. | ~5 min |

None of these block anything. Items 2, 3 and 5 are one-line changes.
