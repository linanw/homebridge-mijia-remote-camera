# Changelog

## 0.4.3 — 2026-10-24

- Name the existing HomeKit night-vision control 手动夜视 and add 自动夜视, with distinct `Name` and `ConfiguredName` values and the original service identity preserved.
- Reflect manual, automatic and off policies as two mutually exclusive switches. Serialize fresh mode checks and conditional changes with other camera-control requests, so an already-off switch does not disable the other mode.
- Synchronize both controls from confirmed Xiaomi/UI/Matter mode observations and prevent an older in-flight read from overwriting a newer observed mode.

## 0.4.2 — 2026-10-24

- Publish explicit HomeKit `ConfiguredName` values for the four camera direction switches: 云台向上, 云台向下, 云台向左 and 云台向右.
- Repair default service names in place while preserving existing custom configured names, service identifiers, pairing and automation targets.

## 0.4.1 — 2026-10-24

- Accept the trusted Homebridge storage alias used by Synology Docker during GUI component import. User-selected descendants still reject symbolic links and directory escapes.
- Verify GUI imports and immutable repeat imports through an aliased root, with legal notices preserved.
- Make encrypted loopback CASE tests independent of multicast discovery and bound unreachable-peer cleanup.

## 0.4.0 — 2026-10-24

- Add 60-second selected-camera metadata polling and manual refresh for the Mi Home name, home and room. Preserve accessory identity and active media during metadata updates.
- Add guarded owner-only device rename and moves to an existing room in the same Mi Home home, through the settings page and the vendor Matter metadata interface. Enable writes only after the runtime capability is validated. Each action sends one write and independently confirms the result; shared homes remain read-only.
- Validate real Chinese device-name rename/restore and moves between two existing rooms with independent readback and unchanged credentials. Cloud name rules can remove characters; exact readback rejects an emoji-normalized result rather than reporting confirmation.
- Keep Apple Home name/room writeback deferred. Room creation, room renaming, moves across homes and moves to the home root are unsupported.
- Add asynchronous local runtime import in Homebridge UI without requiring a terminal. Keep the fixed component hashes, legal notices, storage boundary and active-owner protection.
- Declare Node.js 22.13.1+ / 24 and Homebridge 1.11.4+ / 2 compatibility, with Homebridge 2.4.0 as the current development dependency. Add a public-source CI matrix and verification preparation notes.
- Preserve Unicode metadata and the cross-language revision fingerprint even when a container configures stdout/native argument encoding as US-ASCII; use strict UTF-8 through an ASCII-only internal rename transport. Bound Matter metadata strings to 160 UTF-8 bytes without silently truncating edits.

## 0.3.0

- Add finite up/down/left/right direction steps for validated camera models, optional HomeKit direction switches and the vendor Matter direction-step interface.
- Retain HomeKit video, real camera audio, talkback, night vision and experimental Matter camera streaming.

## 0.2.x

- Add experimental Matter Camera with WebRTC media, commissioning storage and multiple viewers sharing compatible encoders.
- Improve stream cleanup, negotiation and independent talkback ownership.

## 0.1.x

- Introduce the scoped standalone Homebridge platform, official Xiaomi sign-in, home/device selection and native HomeKit camera streaming.
- Add real PCMA/Opus listening, HomeKit talkback, validated night-vision control and local runtime import.
