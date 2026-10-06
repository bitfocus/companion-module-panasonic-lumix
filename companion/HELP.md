# Panasonic Lumix

This module controls Panasonic Lumix Wi-Fi-enabled cameras, including the S5II and S5IIX access/session flow.

## Setup

1. Connect the camera and Companion computer to the same network.
2. Put the camera into its Wi-Fi remote-control mode.
3. Enter the camera IP address in the connection configuration.
4. Approve the controller on the camera if prompted.

The module reads the camera identity from port 60606, requests access, stores the returned session ID, and includes it in subsequent commands. The session ID is not written to the log.

Commands wait for the entire handshake, including controller-name confirmation and a successful `recmode` request. Every new session establishes shooting mode because the camera can leave it when a new controller connects; established sessions do not repeat this step on each action. Shooting-mode setup retains its 15-second command window. A failed setup discards the provisional session. A completed discovery reply is reused during this client's retries for the same host; partial/invalid discovery replies and session tokens are never cached for reuse after failure. Host changes, a new client, or disconnect discard the discovery cache. Established sessions are reused rather than replaced by a delayed reconnect timer.

Discovery and pairing requests allow up to 30 seconds each, avoiding premature restarts when the response stalls. The reconnect delay is unchanged. Recording command requests allow 15 seconds each, and heartbeat requests allow 8.5 seconds; the configured heartbeat interval is unchanged. These are maximum waits, not added delays: fast replies are handled immediately. Recording commands are independent and can overlap each other and the heartbeat. Heartbeats never overlap other heartbeats; a polling tick is skipped while a heartbeat is pending. Start and Stop may reach the camera or return replies out of order. A request that exceeds its timeout still fails; a timed-out recording request is not automatically resent, since it may already have reached the camera.

Enable **Log Every Camera Request and Response** in the connection settings for troubleshooting. Existing Debug Logging settings carry over. Traces appear at Info level in Companion's log: each request has a matching number, URL, headers, timeout, response headers, full response body and elapsed time. Failures include the request phase and any partial response; intentional heartbeat cancellations are identified separately. Pairing values, session credentials, camera UDN and serial number are redacted. Disable this option after testing to reduce log volume. The module cannot log a camera-side disconnect notification unless it arrives as an HTTP response; note the time of any camera-screen message when sharing logs.

## Actions

For the current session-maintenance experiment, **Enable ISO Heartbeat** sends only `mode=getsetting&type=iso`. It preserves your saved heartbeat interval and the 8.5-second response window. No periodic `getstate`, PA, other settings, or `getinfo` requests are sent. Disabling polling or setting the interval to zero sends no initial or periodic heartbeat requests; status then reflects the last successful command, not a live connection check. Whether ISO reads alone keep the S5II/S5IIX session alive needs actual-camera testing.

Recording actions run in the background so Companion's five-second action-call limit does not report a false timeout. Start sends only `video_recstart`; shooting mode is established once during connection setup. Each button press immediately starts its own request once a session is established, except duplicate Start or duplicate Stop requests are ignored while the same command awaits a reply. Start and Stop remain independent, with no queue or ordering. Feedback changes only on success; failures are logged. An action callback returning immediately means submitted, not confirmed. Actions in Companion following this one do not wait for camera confirmation.

Three consecutive heartbeat replies returning `err_busy` trigger a latched safety stop: no new camera requests, polling, or automatic reconnection. A successful heartbeat or any other heartbeat error resets the streak; skipped heartbeat ticks do not. Busy action replies fail that action without changing the heartbeat streak or stopping traffic. Pending heartbeat requests are cancelled after the safety stop, and late replies cannot restore a healthy status. Requests already delivered to the camera cannot be undone. Recover the camera first, then disable and enable the module to resume. Do not repeatedly press recording buttons or restart the module while the camera is unresponsive. This safeguard does not prove or fix the cause of a camera lockup.

An `err_critical` reply from any cam.cgi request immediately invalidates that session and starts a fresh connection attempt. Duplicate errors from the retired client do not start overlapping reconnects, and replies from its pending actions cannot update the new connection. Recording commands are not automatically replayed after recovery. If reconnection fails, the normal delayed connection retries apply. Other polling failures and timeouts do not initiate reconnection.

- Video Record Start
- Video Record Stop

Recording feedback changes after the camera accepts a recording action, not from background polling in this experiment. Changes made on the camera itself are not tracked. ISO heartbeats carry the session header, allow up to 8.5 seconds per reply, and never overlap each other. Recording commands remain independent of each other and polling; no command waits for or cancels another request. Polling failures show a warning but do not reset the session except for `err_critical`, which triggers immediate recovery. Explicit `err_session` or `err_reject` replies from a control command also initiate session renewal. A successful heartbeat requires an `ok` result and a recognized ISO value; `err_no_data` is not success. The configured interval provides poll opportunities, but ticks are skipped while a heartbeat is pending.

## Exposure and Image Settings (Experimental)

Actions are available for ISO, aperture, shutter speed, exposure compensation, focus mode, metering, focus peaking, filter, colour mode/photo style, and video quality. Their request names follow `njfdev/liblumix`. ISO reads and controls have been exercised on the development camera; the remaining setting controls still need hardware verification. Lens, shooting mode and recording state may restrict availability. No photography, media-download, playback-mode or streaming actions are included.

Available settings are downloaded once in the background after each successful connection, populating setting-action dropdowns when the complete menu arrives. Heartbeats and controls continue independently. Menu downloads (`allmenu` and `curmenu`) allow up to 60 seconds; other information requests retain 15 seconds. Repeated requests for the same information on the same client share its pending download rather than sending duplicates. An ordinary information timeout does not mark the connection disconnected or retry pairing; the `err_critical` recovery and `err_busy` safety stop still apply. A failed initial download is not automatically retried: use **Read Camera Information / Available Settings**, selecting **Available settings**, to retry or refresh it manually. Reopen the action editor after reading the menu. A missing choice does not prove a setting is unsupported: some menus use dynamic ranges or extra value parameters, which this version deliberately omits. Custom values must be the exact camera protocol token, not a guessed display value. In particular, aperture and shutter speed can use encoded fractions such as `1366/256` and `2560/256`; these are not ordinary f-numbers or exposure-time fractions. Do not assume an example is supported by your camera.

**Read Current Setting** reads one selected setting immediately. The ISO-only heartbeat refreshes `setting_iso` on every successful reply. Other settings are not automatically read or rotated; they update only after a manual read or accepted setting change. The initial available-settings download is the only automatic `getinfo` request.

The `setting_*` variables and **Setting Value** feedback update after a successful read or acknowledged setting change. An unrecognized successful ISO reply marks ISO `Unknown`; failed requests retain its last-known value and heartbeat failures show a warning. `err_critical` still triggers session recovery; only three consecutive busy heartbeat replies stop traffic. Setting changes use the existing session, request timing and safety stop. Commands are not automatically replayed after a timeout. Test one setting at a time while not recording, and check the camera itself.

The information action also provides manual capability, current-menu and lens reads. `last_info_xml` contains up to 4096 characters of the last successful information reply, marked when truncated; request tracing records the complete reply. Menu labels prefer English when supplied. Menu contents can become stale after a lens or mode change; read the menu again when needed.

### ISO Increase and Decrease

**ISO Increase (Next Value / 1/3 Stop)** and **ISO Decrease (Previous Value / 1/3 Stop)** move to the next/previous numeric ISO reported in the available-settings menu, sorted numerically. On a third-stop list this is one third stop; no values are invented for coarser lists. Auto is excluded and limits do not wrap. This unbuffered experiment sends each press immediately, independently of pending ISO requests. A pending target advances with each press, so rapid presses request distinct successive values even before acknowledgments. Requests may reach or execute on the camera out of order; final ISO is not guaranteed to match the last press. Older acknowledgments do not overwrite newer accepted targets in variables; subsequent heartbeat reads reconcile the actual camera value. Select a manual ISO and wait for its heartbeat/read before stepping if ISO is unknown. Failed requests mark ISO unknown and block more steps until outstanding replies complete and a fresh ISO value is available. No changes are automatically replayed. Recording/heartbeat timing and err_busy safety stop are unchanged; already delivered requests cannot be undone. Avoid mixing direct ISO actions or camera-side changes with an in-flight burst.

## Status Variables and Feedback

In this ISO-only experiment, battery, camera mode, remaining capacity, progress time, temperature, card status and warnings are not refreshed. Their variables remain `Unknown` after connection reset. **Recent State Reply** remains false because an ISO reply is not a state reply. Setting reads work as described above. These feedback definitions remain available for future state polling, without silently adding any `getstate` requests.

New boolean feedbacks include low battery (camera level or reported percentage), camera mode, temperature status, card full/writable/activity, setting value, and a recent successful state reply. **Recent State Reply** is reevaluated locally every second, with a configurable age limit; it becomes false after a safety stop or when replies become stale. Other status values remain last-known after a lost connection, so use this freshness feedback alongside them. Battery-level feedback assumes the reported `x/5` camera scale; percentage feedback stays false when percentage is unavailable.

## Variables

- Recording State
- Camera Model
- Current settings (`setting_*`), updated by reads and acknowledged writes
- Last information type and XML (up to 4096 characters)
- State telemetry and last state reply time (unavailable with ISO-only polling)

## Feedbacks

- Recording State
- Setting Value
- Battery, mode, temperature, card status and Recent State Reply (unavailable with ISO-only polling)
