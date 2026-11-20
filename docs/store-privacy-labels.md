# Store privacy labels: device feedback (#574)

These are the answers to add for **Send feedback to Fug Studio** (opt-in device
metrics, [design/device-metrics.md](design/device-metrics.md)). They go next to
the existing answers (Splanc AI credits, feedback reports). The owner enters
them in App Store Connect and the Play Console before the release that ships
the setting.

## App Store Connect ▸ App Privacy

Add these data types. Each is **collected**, **not linked to the user's
identity**, and **not used for tracking**.

| Data type                               | Linked to you | Tracking | Purposes                     | What it is                                                                                                                           |
| --------------------------------------- | ------------- | -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Diagnostics ▸ **Crash Data**            | No            | No       | App Functionality, Analytics | Restart reasons and crash, watchdog and brownout counts from players                                                                 |
| Diagnostics ▸ **Performance Data**      | No            | No       | App Functionality, Analytics | Frame rates, memory headroom, Wi-Fi signal, link drops, mesh delivery                                                                |
| Diagnostics ▸ **Other Diagnostic Data** | No            | No       | App Functionality, Analytics | Uptime, firmware and app versions, board type, LED count                                                                             |
| Usage Data ▸ **Product Interaction**    | No            | No       | Analytics                    | App opens, which main screens open, number of effects sent (counts only)                                                             |
| Identifiers ▸ **Device ID**             | No            | No       | Analytics                    | The random install and player codes. They rotate every 30 days and are never tied to an account (declared to be safe; see Decisions) |

Notes for the review questions:

- **Optional?** Yes. It is off by default, the user turns it on per category,
  and can turn it off or delete the data at any time.
- **Third parties:** Cloudflare (transport) and Grafana Cloud (storage) process
  the data for Fug Studio only. That is not "sharing" in Apple's sense: they
  are service providers.
- **Privacy policy URL:** wherever [privacy.md](privacy.md) is published (see
  Decisions).

## Google Play Console ▸ Data safety

- **Does your app collect or share any of the required user data types?** Yes.
- **Is all of the user data collected by your app encrypted in transit?** Yes
  (HTTPS).
- **Do you provide a way for users to request that their data is deleted?** Yes:
  Settings ▸ Privacy ▸ Delete my data.

| Category ▸ type                                           | Collected | Shared | Optional          | Ephemeral | Purposes                     |
| --------------------------------------------------------- | --------- | ------ | ----------------- | --------- | ---------------------------- |
| App info and performance ▸ **Crash logs**                 | Yes       | No     | Yes (user choice) | No        | Analytics, App functionality |
| App info and performance ▸ **Diagnostics**                | Yes       | No     | Yes               | No        | Analytics, App functionality |
| App info and performance ▸ **Other app performance data** | Yes       | No     | Yes               | No        | Analytics, App functionality |
| App activity ▸ **App interactions**                       | Yes       | No     | Yes               | No        | Analytics                    |
| Device or other IDs ▸ **Device or other IDs**             | Yes       | No     | Yes               | No        | Analytics                    |

Play counts app-generated installation identifiers as "Device or other IDs",
so the rotating install code is declared there.

## What doesn't change

- **Not collected:**
  - location;
  - contacts;
  - user content (maps, effects, chats: device feedback never includes them);
  - names, email, and Wi-Fi details.
- **Not used for:**
  - advertising;
  - tracking across apps;
  - data brokers.
