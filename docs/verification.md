# Homebridge verification status and evidence

Reviewed against the [current official criteria](https://github.com/homebridge/plugins/wiki/Verified-Plugins) on 2026-10-24. Release **0.4.1** is public on [npm](https://www.npmjs.com/package/@linanw/homebridge-mijia-remote-camera), with matching [GitHub source and release](https://github.com/linanw/homebridge-mijia-remote-camera/releases/tag/v0.4.1). [Verification request #1296](https://github.com/homebridge/plugins/issues/1296) has been submitted and is open with `pending` / `request-verification` labels. **The Homebridge team has not granted verification.** The project's own checks and CI do not constitute approval, and no Verified badge is displayed.

## Compatibility and distribution

| Area | Declared scope |
| --- | --- |
| npm name | `@linanw/homebridge-mijia-remote-camera` |
| Platform | Dynamic platform `MijiaRemoteCamera`; external native HAP camera; optional independently registered Matter camera |
| Review release | Public npm and matching GitHub release 0.4.1; code commit `b0fcb441872d5fd38e6035b18a3967c9e7c49421` |
| Node.js | `^22.13.1 || ^24.0.0` |
| Homebridge | `^1.11.4 || ^2.0.0`; current development dependency 2.4.0 |
| OS / CPU | Linux x64 only; pinned local runtime contains glibc and musl variants |
| Current device validation | One Xiaomi Smart Camera 3 Pro PTZ, CS2/vendor 4; other models are not promised |
| Initial configuration | Homebridge Plugin Settings GUI; asynchronous local component import, official Xiaomi login, home and camera selection |
| Runtime components | Existing, matching user-owned local components; no acquisition service, bundled vendor runtime, or automatic download |

The current criteria specify the supported Node LTS lines, currently 22 and 24. They do not state a universal OS/CPU support requirement. **Linux x64 remains a material limitation for the reviewers to assess**, especially for Raspberry Pi and other ARM users. A successful npm installation without the local components does not provide working video.

## Criteria and evidence to present

| Official requirement | Implementation / review evidence |
| --- | --- |
| Dynamic platform and a distinct purpose | Registered platform with a single selected external camera; the comparison below explains the remote Xiaomi transport use case |
| Public npm and GitHub source with Issues enabled | Public source and Issues are available; npm 0.4.1 and the matching GitHub release are published |
| Supported Node LTS, clean installation and no unconfigured startup | All six public CI combinations passed; anonymous fresh nonroot installation of npm 0.4.1 and unconfigured Homebridge startup passed without creating the plugin runtime, account session or camera |
| No system-changing postinstall or TTY setup | No plugin lifecycle install scripts; local import and account setup are in Homebridge UI; CLI tools are optional |
| Settings GUI | Schema plus protected custom settings page |
| No analytics or tracking | No author-operated analytics service; Xiaomi account, cloud metadata and remote-camera services are necessary network dependencies |
| Files confined to Homebridge storage | Private credentials, selection, local runtime and Matter identity under the instance storage directory; inspect clean-runtime writes during final review |
| Errors handled by the plugin | Bounded public errors, caught background work and shutdown failures; source tests cover safe failure paths |

The official [checker implementation](https://github.com/homebridge/plugins/blob/latest/src/plugin-checks/workspace/index.ts) also checks package metadata, dependency placement, configuration, repository/release availability and runtime behavior. `homebridge` is a development dependency; HAP is obtained from the host. HTTPS homepage/issues and both `supports-hap` and `supports-matter` describe the actual transports. A production `npm audit --omit=dev --json` on 2026-10-24 reported **0 vulnerabilities**. This local audit does not replace the Homebridge team's checks.

## Distinction from related verified plugins

The comparison uses the [official verified list](https://github.com/homebridge/plugins/blob/latest/verified-plugins.json) and the projects' own documentation. It explains a separate use case and does not claim broader feature coverage than those projects.

| Project | Published capability and difference |
| --- | --- |
| [Camera FFmpeg](https://github.com/homebridge-plugins/homebridge-camera-ffmpeg) | Its configuration requires an FFmpeg input source, usually an existing camera URL. This plugin obtains the selected supported Xiaomi camera's remote P2P source through account/home selection instead of requiring the user to supply that URL. |
| [camera.ui](https://github.com/SeydX/homebridge-camera-ui) | Its documentation targets cameras exposing RTSP and includes recording, HSV and motion features. This plugin targets the Xiaomi remote transport and does not implement HSV or recording. |
| [homebridge-miot](https://github.com/merdok/homebridge-miot) | A broad Xiaomi MIOT device-control platform that explicitly lists a camera category. Its current [CameraAccessory](https://github.com/merdok/homebridge-miot/blob/main/lib/modules/camera/CameraAccessory.js) builds a power switch, while [CameraDevice](https://github.com/merdok/homebridge-miot/blob/main/lib/modules/camera/CameraDevice.js) monitors MIOT power/indicator/storage properties; those classes do not implement a HomeKit streaming delegate. Our request specifically adds the tested remote camera video/audio/talkback transport and scoped metadata, rather than claiming that homebridge-miot has no camera support. |

A related [homebridge-xiaomi-go2rtc project](https://github.com/moguennouni/homebridge-xiaomi-go2rtc) now documents local Xiaomi camera streaming and controls, automatic go2rtc provisioning and broader server architectures. It was not present in the official verified list checked for this preparation. Its overlapping functionality must still be disclosed; acceptance of a distinct use case is the Homebridge team's decision.

Another related project, [homebridge-xiaomi-camera-native](https://github.com/Kosztyk/homebridge-xiaomi-camera-native), has an open [verification request #1289](https://github.com/homebridge/plugins/issues/1289), marked `awaiting-final-review` on 2026-10-24. It was not in the official verified list checked on that date. Its [README](https://github.com/Kosztyk/homebridge-xiaomi-camera-native/blob/main/README.md) describes direct LAN MISS/CS2 video, snapshots and pan/tilt, requires LAN access to the camera, and explicitly excludes audio and two-way talk. This plugin's validated remote transport, camera audio/talkback and Mi Home/Matter metadata are relevant differences. Both the existing overlap and the pending application should be considered by the reviewers; no general feature-superset or replacement claim is made.

## Scope that must remain explicit

- The npm package excludes micam, its native components, JRE and FFmpeg. The known local backend repository has no license, and the known FFmpeg build enables `nonfree`. No redistribution rights are asserted. See [third-party notices](../THIRD_PARTY_NOTICES.md).
- The GUI importer accepts only already-held matching files inside Homebridge storage, verifies fixed hashes and preserves legal files. It solves terminal-free import; it does not solve lawful acquisition for a new user without components. Reviewers may regard that remaining setup limitation as blocking.
- Mi Home metadata polls every 60 seconds. Confirmed owner-only edits cover the device name and moves to existing rooms of the same home; cloud-side name normalization can reject exact confirmation even for locally valid Unicode; the runtime must expose the validated write capability before editing is enabled. Shared homes are read-only. There is no room rename/create or cross-home move.
- Apple Home's own name and room edits are not written back to Mi Home. Matter metadata uses a vendor interface and a 160-byte UTF-8 bound; controllers must explicitly support it. Neither of these features is a universal HomeKit/Matter room sync promise.
- Matter remains an experimental development device using SDK test attestation. Homebridge verification, if granted, would not confer Matter product certification.

## Validation and release status

The [0.4.1 public CI run](https://github.com/linanw/homebridge-mijia-remote-camera/actions/runs/40076759349), for code commit `b0fcb441872d5fd38e6035b18a3967c9e7c49421`, passed all six combinations of Node 22.13.1 / current 22.x / 24.x and Homebridge 1.11.4 / 2.4.0. It installs public dependencies and runs unfiltered `npm test` without proprietary runtime assets. Codec-dependent HomeKit media, Java/vendor protocol fixtures and the full-runtime UI IPC fixture explicitly skip when their required components are absent. Public CI therefore does not replace the separately reported full-runtime and real-device validation.

The final 0.4.1 local full suite, with the held runtime and an independent Matter controller integration, passed on **Node 22.22.1 and Node 24.19.0 / Homebridge 2.4.0: 328 tests, 327 passed, 1 root-only ownership test skipped, 0 failed on each Node version**. Real-account validation changed a Chinese camera name and restored it, moved the camera between two existing rooms of its owned home and restored the original room, and independently read back each result. The original name/room and credentials were preserved at completion. An emoji-containing target was normalized by the cloud, correctly returned `metadata_not_applied`, and was restored; the plugin does not promise arbitrary cloud name characters or automatic rollback.

Anonymous installation of **0.4.1** from the public npm registry into a fresh nonroot environment passed with lifecycle scripts disabled. Unconfigured Homebridge loaded the plugin and started normally without creating the plugin runtime, account session or camera. The public tarball contains no vendor runtime assets, and its production dependency audit reported **0 vulnerabilities**. These installation checks do not establish working video for users without the matching local components.

- [x] Publish the reviewed source to the intended public GitHub repository, enable Issues, and verify all package URLs resolve.
- [x] Complete changed-value Chinese rename/restore and existing-room round-trip validation with independent reads, original values restored and credentials unchanged. Confirm exact readback rejects a cloud-normalized emoji result; run the final local suite on Node 22 and 24.
- [x] Public [0.4.1 CI matrix](https://github.com/linanw/homebridge-mijia-remote-camera/actions/runs/40076759349) passed all six combinations. Anonymous fresh nonroot registry installation and unconfigured Homebridge startup passed.
- [x] Inspect the exact npm tarball and Git tree for credentials, imported assets, APK/DEX/decompiled code and third-party binaries. Only the project's own Java adapter JAR is intended for distribution.
- [x] Publish npm 0.4.1 and a matching GitHub release with release notes; verify the default-branch package version matches npm latest.
- [x] Refresh the production audit and official criteria/checker findings, then provide the limitations and comparison to the reviewers.
- [x] Submit [verification request #1296](https://github.com/homebridge/plugins/issues/1296) for 0.4.1; it is awaiting official review.
- [ ] Address official review feedback and await the Homebridge team's decision. Add a Verified badge only if verification is granted.

The [official request form](https://github.com/homebridge/plugins/issues/new?template=1_verification-request.yml) requires the npm name, public repository and six Yes/No declarations. A roughly 100×100 PNG icon is optional and must respect licensing/trademarks. Include setup restrictions and test evidence in More Information. Use the [current template](https://github.com/homebridge/plugins/blob/latest/.github/ISSUE_TEMPLATE/1_verification-request.yml); repository transfer or a package scope change is not required for this request. The project team performs the review described in the [program documentation](https://github.com/homebridge/plugins#plugin-verification).

The 0.4.1 patch accepts a Homebridge-configured storage-root symlink such as Synology's default alias, while still refusing user-selected symlink descendants, escapes and root-directory imports. Component import and repeat import through that alias are covered by independent fixtures. The protected settings UI and its name/room region were confirmed visible by the user on the real NAS; active custom-UI IPC returned current metadata and import readiness without errors.
