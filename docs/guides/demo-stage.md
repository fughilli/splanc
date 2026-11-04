# Run a demo night with the Splanc stage

`splanc-agent stage` turns a laptop and a TV into a live demo: you speak a request, Claude
writes an effect, and the audience watches it happen. The stage page shows the code as it is
being written, every step (compile, preview, deploy), Claude's reply in large type (and
spoken aloud), a live preview of two fixtures on their real maps, and, next to all that,
your phone's screen (mirrored), so the audience can follow the app while you map a fixture or
play with effects. Ask Claude how something works and it explains the code on screen,
highlighting and labelling each part as it talks.

```text
 ┌──────────┬──────────────────────────┬────────────────────┐
 │          │ Effect: Pumpkin glow     │ "make the pumpkins │
 │  your    │  uniform float warmth …  │  breathe slowly"   │
 │  phone   │  vec3 shade(Led led) {   │ Breathing orange…  │
 │ (mirror) │  …                       │ ● Compile   41 ms  │
 │          ├──────────────────────────┴────────────────────┤
 │          │ Live preview  [SpookySplanc1] [SpookySplanc2] │
 └──────────┴───────────────────────────────────────────────┘
```

## What you need

- A Mac on the same Wi-Fi as the fixtures, with Chrome or Safari (for speech recognition).
- A TV on HDMI, set up as an extended display.
- An iPhone with the Splanc app and a USB cable (for the mirror). Mirroring over AirPlay works
  too, but a cable doesn't drop out on busy venue Wi-Fi.
- A **Claude API key**: create one at console.anthropic.com → API keys. Each spoken request
  costs roughly 5–15¢ (Claude Opus 5.5). Give the key a spend limit for the night.
- Optional: a microphone (a USB or lapel mic beats the laptop's own), and a presenter clicker.

## Start it

```sh
export ANTHROPIC_API_KEY=sk-ant-…          # or: --api-key-file ~/claude.key
npx -y https://splanc.io/agent/splanc-agent.tgz stage
```

It finds the fixtures the same way the MCP server does, then opens the stage page
(`http://localhost:7420/`). Drag that window to the TV and make it full screen (Chrome:
Ctrl+Cmd+F). Each fixture with a stored map appears in the live-preview strip right away,
dimmed, until an effect runs on it.

Options: `--port 7420`; `--effort low` for quicker, simpler replies (default `medium`);
`--lan` also serves the page to other devices on the network, behind a key printed at start (the
microphone works only on the laptop itself); `--no-open` doesn't open the browser.

## Put the phone on screen

1. Plug the iPhone into the Mac and unlock it.
2. Open **QuickTime Player** → File → New Movie Recording. Next to the record button, open the
   menu and pick the iPhone as the camera. The phone's screen appears in the window.
3. In the stage page, click **Phone** and pick the QuickTime window. It appears in the phone
   slot at the left. Click **Phone** again to hide it.

Keep the QuickTime window on the laptop screen, not the TV. Hiding it behind other windows is
fine.

## Talk to it

| Do this                                        | To                                                        |
| ---------------------------------------------- | --------------------------------------------------------- |
| Hold **Space**, speak, release                 | send a request (what you say appears as you speak)        |
| Clicker **Page Down** / **Page Up** (or **B**) | start listening, then press again to send                 |
| **Enter**                                      | type a request instead                                    |
| **V**                                          | turn Claude's voice on or off                             |
| **Esc**                                        | stop Claude mid-answer (and its voice)                    |
| **New**                                        | start a fresh conversation                                |
| **Maps**                                       | re-read the fixtures' maps (after mapping one in the app) |

Things that demo well:

- "Make the curtain look like a slow ocean wave, deep blue and teal."
- "Faster." / "Warmer." / "Calmer." Claude turns the running effect's knobs instead of
  writing a new one.
- "Now fade both fixtures to a flickering candle." Claude crossfades both in sync.
- "Go back." Claude rolls back to the previous effect.
- "Show me the rope's map." Claude plots the fixture.
- "How does that work?" / "What does the speed knob do?" Claude explains the code (below).
- "Show me the wreath." Claude brings that fixture into the live preview (below).

The conversation carries on between requests, so follow-ups like "same, but purple" work.

On stage Claude can only use the effect and look tools. It can't rename fixtures, update
firmware, change Wi-Fi, delete saved looks or re-trust certificates, whatever it hears.

## Claude explains its code

Ask a question about an effect ("how does the breathing work?", "why is it so smooth?", "what
does line 12 do?") and Claude teaches from the code panel. It talks through the code a step
at a time; as each sentence starts, the part it's about is highlighted, boxed or underlined,
gets a short comic-style label, and scrolls into view. To explain a different effect, name it
("explain the candle effect from the library") and Claude opens it in the code panel first.
Questions don't change the lights unless you ask for that too.

Claude's replies are spoken aloud by the browser's built-in voice; the words light up as they
are spoken. Press **V** (or the **Voice** button) to turn the voice off; walkthroughs then
step along at reading pace. Pressing Space to talk cuts the voice off. To pick a voice, add
`?voice=` and part of its name to the page address (e.g. `?voice=Daniel`), and `&rate=0.95`
to slow it down. On macOS, the most natural voices are the "Enhanced" and "Premium" ones
(System Settings → Accessibility → Spoken Content → System voice → Manage Voices).

## Which fixtures are on screen

The live-preview strip shows two fixtures. It starts with the first two that have a map,
and follows Claude: when it deploys to one or two fixtures, they come on screen. Ask to see
others ("show me the wreath", "put the arch next to the curtain") and Claude brings them up;
the most recent stay up, and the header says how many fixtures there are in all. A fixture
the stage hasn't deployed to shows its map, dimmed, until an effect is put on it.

## Demo mapping

Mapping happens in the Splanc app on the phone, so the audience watches it in the phone slot:

1. In the app, start mapping the fixture and walk through the capture as usual.
2. When the solve finishes and the map is saved, click **Maps** on the stage. The preview strip
   redraws the fixture with its new map.
3. Ask for an effect that uses the shape, e.g. "a rainbow that climbs from the bottom to the
   top". It now follows the real LED positions.

## Rehearse first

Do one full run at home on the night's network:

- Start the stage, check that both fixtures show in the preview strip.
- Make three or four requests and check that the lights change and the preview matches.
- Check the mic level: what you say should appear while you're still speaking. Chrome's speech
  recognition needs the internet; Safari's works offline on recent macOS.
- Ask one "how does it work?" question and listen to the voice through the room's speakers;
  pick a voice you like (see above). Keep the speakers away from the mic.
- Check the phone mirror, and the clicker if you use one.
- Watch the cost of the run on console.anthropic.com.

## If something goes wrong

- **"Claude API: 401"**: the key is wrong or not set in this terminal.
- **"Microphone: not-allowed"**: allow the microphone for the page (the camera/mic icon in the
  address bar), then reload.
- **A fixture missing from the preview**: ask Claude to show it. If it still doesn't appear,
  it isn't reachable or has no stored map: ask "find the fixtures", or check it in the app.
- **No voice**: click anywhere on the page once (browsers only speak after you've interacted
  with the page), check that **Voice** is on, and check the Mac's output device.
- **The preview doesn't match the lights**: the preview runs the same VM on the same map, but
  isn't synced to the fixture's clock, so motion can be out of phase; colours and shapes should
  match.
