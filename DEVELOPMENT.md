# Lumix development and testing

## Protocol references

- [njfdev/liblumix](https://github.com/njfdev/liblumix): primary S5IIX-tested reference for discovery, access-control encoding, session headers, and setting commands.
- [totoantibes/LumixCameraAscomDriver](https://github.com/totoantibes/LumixCameraAscomDriver): secondary reference for `cam.cgi` commands and polling. Its older access flow is not used in place of the S5IIX session handshake.

The libraries poll `getstate`; this implementation instead reads ISO for its periodic heartbeat. Earlier hardware experiments with state/PA polling produced errors and disconnections. ISO polling is a locally tested choice, not a documented guarantee that every Lumix model renews its session this way.

## Current connection flow

1. Read `/Lumix/Server0/ddd` on port 60606 and validate the camera identity.
2. Send `mode=accctrl&type=req_acc_g` to `/cam.cgi` on port 80.
3. Request access with `req_acc_e` using the encoded identity/controller values, allowing camera-side approval.
4. Store the session ID and confirm the controller name.
5. Enter `recmode` once per new connection before controls can proceed.
6. Send subsequent requests with `X-SESSION_ID`.
7. Read ISO initially and periodically, and fetch the available-settings menu once in the background.

Discovery and access requests allow 30 seconds, shooting-mode setup and ordinary controls 15 seconds, ISO heartbeats 8.5 seconds, and menu downloads 60 seconds. These limits are maximum waits rather than deliberate delays. Complete discovery is reused only during retries on the same client/host; failed pairing never exposes its provisional session to actions.

Heartbeats never overlap each other. Controls can overlap heartbeats and other controls; duplicate pending recording Start or Stop requests are ignored. Rapid ISO steps reserve successive targets locally and send independently. The camera can execute concurrent controls out of order. A timed-out write has an unknown outcome and is not automatically replayed. Explicit `err_session`/`err_reject` control replies renew the session and retry once; `err_critical` instead retires the client and reconnects without replaying its failed action.

Only three consecutive `err_busy` heartbeat replies latch the safety stop. Other heartbeat outcomes reset that streak; busy action replies do not stop all traffic. After a safety stop, recover the camera and disable/re-enable the connection manually. Earlier stress experiments caused camera lockups requiring battery removal. The current safeguards are not proof that concurrent traffic is safe on every model/firmware.

## Local setup

The manifest requires module API 2.0 and the Node 22 runtime. Hardware development used Companion 5.0.7; other compatible versions still need runtime testing.

1. Install dependencies with the package manager specified in `package.json`.
2. Set Companion's developer modules path to the parent folder containing this repository; the manifest is `companion/manifest.json` and the entrypoint is `src/main.js`.
3. Add a Lumix connection using the **Dev** version. Connect the camera and computer to the same network and put the camera in Wi-Fi remote-control mode.
4. Configure the camera IP, enable the ISO heartbeat, and approve the controller if prompted.
5. The current default interval is 1000 ms; the owner's latest testing used 4500 ms. Saved intervals are retained for configurations already using the heartbeat option.
6. Enable **Log Every Camera Request and Response** only while diagnosing. Credentials and discovery identifiers are redacted, but logs still include network addresses and camera settings.

Run offline tests with `npm test` and build an importable package with `npm run package`. Restart the development connection after changes when needed.

## Testing evidence and release limitations

The owner has exercised pairing, recording start/stop, idle operation, ISO reads, available-settings downloads, and automatic recovery on their camera. Earlier tests included over 15 minutes connected and over 10 minutes between controls, but subsequent experiments also showed disconnections and variable response latency. This is not a controlled soak-test result for the final revision.

The exact camera model and firmware must be recorded before claiming separate S5II and S5IIX coverage. The S5IIX protocol reference does not substitute for testing both models. Older Lumix cameras and legacy configurations still need hardware compatibility testing.

Offline tests cover handshake ordering, failure isolation, session recovery, request tracing/redaction, non-overlapping heartbeats, busy streaks and safety stops, settings/menu parsing, ISO stepping, stale replies, and Companion actions/feedback. They do not establish firmware stability or real-world request ordering.

Before a stable release:

- Record camera model, firmware, lens, network setup, and Companion version for each tester.
- Test cold pairing, reconnects, long idle sessions, sustained recording, and network interruptions.
- Verify rapid ISO presses and recording controls against the camera display, including failed/late replies.
- Hardware-test the remaining exposure/image settings; dropdown availability alone does not prove a setting can be changed.
- Check legacy configuration/action migration and older camera compatibility.
- Review concurrency and busy-stop behavior with maintainers; prefer a prerelease for wider hardware testing.

Recording feedback reflects acknowledged module actions, not camera-side changes. State telemetry remains unknown because no automatic `getstate` polling is performed. Other settings update only from explicit reads or acknowledged writes.
