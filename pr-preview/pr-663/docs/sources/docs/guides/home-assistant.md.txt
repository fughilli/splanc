# Use Splanc lamps in Home Assistant

Splanc lamps work in [Home Assistant](https://www.home-assistant.io/) through the **Splanc
integration**. Each lamp becomes a light you can turn on and off, dim, and switch between its
saved looks, from the Home Assistant app, dashboards, automations and voice assistants connected
to Home Assistant. Home Assistant talks to each lamp directly on your network: no cloud, no
account, and no bridge needed.

```text
Home Assistant ──(your Wi-Fi, encrypted)──▶ Splanc lamp
```

What you get for each lamp:

| In Home Assistant | What it does on the lamp                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| On / off          | Turns the lamp on or off with its own ON/OFF transition (a fade by default, or the transition effect you set up in the Splanc app). |
| Brightness        | The lamp's master brightness.                                                                                                       |
| Transition        | How long that turn-on or turn-off takes, in seconds.                                                                                |
| Effect            | The **saved looks** (keypoints) of the effect that is playing. Picking one morphs the lamp to that look.                            |
| Lid tap (event)   | Fires when someone taps the lamp's lid (its touch sensor). Use it in automations.                                                   |

When you tap the lamp's lid, or change it from the Splanc app, Home Assistant shows the change
within a moment: the lamp tells Home Assistant itself, nothing polls.

## What you need

- Home Assistant 2025.1 or newer, on the same network as your lamps.
- [HACS](https://hacs.xyz/) (the Home Assistant Community Store), to install the integration.
- Splanc lamps on your Wi-Fi (set up with the Splanc app first).
- For on/off and lid taps: lamp firmware with **lamp power** (the touch-sensor update). On older
  firmware, "off" sets the brightness to 0 and "on" brings the last brightness back; update the
  lamp from the Splanc app to get real on/off.

## 1. Install the integration

1. In Home Assistant, open **HACS**.
2. Open the **⋮** menu (top right) ▸ **Custom repositories**.
3. Enter `https://github.com/fughilli/splanc`, choose the type **Integration**, and click **Add**.
4. Search HACS for **Splanc**, open it and click **Download**.
5. Restart Home Assistant (**Settings ▸ System ▸ ⏻ ▸ Restart Home Assistant**).

## 2. Add your lamps

Home Assistant finds Splanc lamps on your network by itself. After the restart, open
**Settings ▸ Devices & services**: each lamp appears under **Discovered**. Click **Add**, then
**Submit**.

If a lamp isn't discovered (some routers block discovery between Wi-Fi and wired devices), add it
by its address:

1. **Settings ▸ Devices & services ▸ + Add integration**, search for **Splanc**.
2. Enter the lamp's address, for example `192.168.1.40` or `splanc-a1b2c3.local`. The Splanc app
   shows it in the device's details.

Pick an area for the lamp and you're done. The light takes the lamp's name from the Splanc app;
you can rename it in Home Assistant like any other device.

> **Tip:** give your lamps a fixed IP address in your router. If a lamp's address changes,
> Home Assistant follows it when it sees the lamp announce itself again, but a fixed address
> avoids the gap.

### The lamp's security certificate

Every Splanc lamp has its own security certificate, made on the lamp the first time it starts.
Home Assistant remembers the one it sees when you add the lamp, and from then on only talks to a
lamp that presents the same certificate.

If the lamp is ever factory-reset (its flash fully erased), it makes a new certificate. Home
Assistant then stops talking to it and shows **Reconfigure** on the lamp under
**Settings ▸ Devices & services**, with both fingerprints. Confirm only if you did reset the
lamp; if you didn't, something else may be answering at the lamp's address.

## 3. Use it

- **Dashboard:** the lamp is a normal light card. Its **Effect** list holds the saved looks of
  whatever effect the lamp is playing; when you change the effect in the Splanc app, the list
  follows.
- **Automations:** use the light actions (`light.turn_on`, `light.turn_off`) with
  `brightness_pct`, `transition` and `effect`, and the **Lid tap** event as a trigger. For
  example, "when the bedroom lamp's lid is tapped after 22:00, turn off every other light".
- **Voice:** Assist, and any voice assistant you've connected to Home Assistant, can turn the
  lamp on and off and dim it like any other light.

Saving new looks, editing effects and mapping still happen in the Splanc app.

## One controller at a time

A Splanc lamp talks to **one app at a time**. Home Assistant is a polite background client:

- **The Splanc app always wins.** When you open the app and use a lamp, the app takes the
  lamp's connection from Home Assistant. Home Assistant lets it go and keeps the lamp in your
  dashboard; its state shows as _assumed_ (the last known values) until it reconnects.
- **Home Assistant catches up by itself** a minute or a few after you stop using the app, and at
  once when you control the lamp from Home Assistant (a tap on the dashboard, an automation or a
  voice command). That command goes through as long as the app isn't actively changing the
  lamp at that moment; if it is, Home Assistant says so and you can try again.

With a **Splanc Bridge** on your network (the Raspberry Pi that connects your lamps to cloud
agents and to Matter), use **one** of these for each lamp, not both:

- this integration, talking to the lamp directly (recommended: it has the saved looks and the
  lid-tap event); or
- Home Assistant's built-in **Matter** integration, pointed at the bridge (see the Splanc Bridge
  (Matter) guide, [matter.md](matter.md)).

Running both against the same lamp makes them take the lamp's connection from each other.

## Apple Home through Home Assistant

Home Assistant's own **HomeKit Bridge** integration can show your Splanc lamps in Apple's Home
app and to Siri. Splanc doesn't implement Apple's HomeKit protocol itself: this route is Home
Assistant's feature, set up and run by you.

1. **Settings ▸ Devices & services ▸ + Add integration ▸ HomeKit Bridge.**
2. Include the **light** domain (or pick your Splanc lights by entity), and finish.
3. Open the notification Home Assistant shows, and scan its pairing QR code with the iPhone's
   Home app (**+ ▸ Add Accessory**).

The lamp's on/off, brightness and transitions work from Apple Home. Saved looks (effects) are
not shown there; use Home Assistant scenes or automations to recall them.

The other Apple route is Matter through a Splanc Bridge (see [matter.md](matter.md)).

## Google Home and Alexa through Home Assistant

Home Assistant can also expose your lamps to Google Assistant and Amazon Alexa:

- **Home Assistant Cloud (Nabu Casa)**, a paid subscription by the Home Assistant team: turn on
  **Google Assistant** and/or **Alexa** under **Settings ▸ Home Assistant Cloud** and choose
  which entities to expose. Then link Home Assistant in the Google Home or Alexa app.
- **Manual set-up**, free but technical: Home Assistant's
  [Google Assistant](https://www.home-assistant.io/integrations/google_assistant/) and
  [Amazon Alexa](https://www.home-assistant.io/integrations/alexa.smart_home/) integrations.

Either way, the lamps appear as dimmable lights that Google and Alexa can turn on, off and dim.
This is Home Assistant's connection to those services, not a Splanc one: Splanc lamps are not
certified for Google Home or Alexa.

## Troubleshooting

| Problem                                                   | What to do                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The lamp isn't discovered                                 | Add it by address (step 2). Discovery needs mDNS between Home Assistant and the lamp; some routers and VLAN set-ups block it.                                          |
| "Could not reach the lamp"                                | Check the address, that the lamp is powered and on the same network, and that the Splanc app isn't busy with it (mapping, uploading an effect). Try again in a moment. |
| The state shows as _assumed_ for a while                  | The Splanc app is (or was recently) using the lamp. Home Assistant reconnects within minutes, or at once when you send it a command.                                   |
| An action fails with "the Splanc app is using the lamp"   | The app is actively changing the lamp. Stop, or close the app's device screen, and try again.                                                                          |
| On/off just dims to 0, and there's no **Lid tap** entity  | The lamp's firmware predates lamp power. Update it from the Splanc app, then reload the integration (**⋮ ▸ Reload** on the lamp's entry).                              |
| **Reconfigure** appears with two certificate fingerprints | The lamp presents a new certificate. Confirm only if you factory-reset it (see "The lamp's security certificate").                                                     |
| The effect list is empty                                  | The playing effect has no saved looks. Save some in the Splanc app; the list follows within a moment.                                                                  |

For a bug report, download the diagnostics (**Settings ▸ Devices & services ▸ Splanc ▸ ⋮ ▸
Download diagnostics**) and attach them to an issue at
[github.com/fughilli/splanc/issues](https://github.com/fughilli/splanc/issues).
