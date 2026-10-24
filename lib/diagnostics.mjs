import { safeMatterStatus } from './matter-diagnostics.mjs';
const states = new Set(['idle', 'starting', 'ready', 'retrying', 'blocked', 'stopped', 'paused']);
const stages = new Set(['device_lookup', 'provisioning', 'relay_connect', 'authentication', 'waiting_video']);
const reasons = new Set(['not_selected', 'starting', 'ready', 'stopped', 'retrying', 'connect_timeout',
  'authentication_required', 'session_expired', 'camera_offline', 'camera_not_in_home', 'unsupported_transport',
  'invalid_request', 'invalid_home_selection', 'invalid_home_response', 'missing_home_owner', 'invalid_device_response',
  'device_pagination_incomplete', 'home_request_failed', 'home_request_rejected', 'discovery_failed',
  'backend_failed', 'connection_failed', 'no_video', 'port_in_use', 'runtime_in_use', 'runtime_closed',
  'runtime_unavailable', 'query_timeout', 'query_cancelled', 'invalid_backend_response', 'storage_failed', 'auth_in_progress']);
const mediaReasons = new Set(['media_unavailable', 'closed', 'source_not_ready', 'source_timeout', 'source_invalid',
  'snapshot_busy', 'snapshot_timeout', 'snapshot_too_large', 'snapshot_invalid', 'ffmpeg_missing', 'ffmpeg_permission',
  'ffmpeg_spawn', 'ffmpeg_exit', 'ffmpeg_cpu_unsupported', 'input_timeout', 'input_unavailable', 'input_invalid',
  'decode_failed', 'encoder_unavailable', 'encode_failed', 'udp_unreachable', 'udp_in_use', 'udp_error',
  'audio_source_unavailable', 'audio_source_invalid', 'audio_negotiation_invalid', 'audio_timeout', 'audio_muted',
  'talkback_unavailable', 'talkback_invalid', 'talkback_timeout', 'talkback_overflow', 'talkback_muted',
  'invalid_prepare', 'invalid_stream', 'start_timeout', 'prepare_timeout', 'receiver_timeout', 'stream_stopped', 'stream_reset']);
const mediaEvents = new Set(['snapshot_requested', 'snapshot_success', 'snapshot_failure', 'stream_prepared',
  'stream_start', 'stream_first_frame', 'stream_failure', 'stream_stop', 'stream_rtcp_first',
  'audio_start', 'audio_first_frame', 'audio_failure', 'audio_stop',
  'talkback_start', 'talkback_first_frame', 'talkback_failure', 'talkback_stop']);
const mediaSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGFPE']);
const mediaStreamStates = new Set(['idle', 'prepared', 'starting', 'active', 'stopped']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => value === null || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));

function safeMediaDiagnostics(value) {
  const result = {};
  for (const key of ['activeStreams', 'activeJobs']) if (count(value[key])) result[key] = value[key];
  for (const [kind, counters, timestamps] of [
    ['snapshot', ['requests', 'successes', 'failures', 'lastBytes'], ['lastRequestedAt', 'lastCompletedAt', 'lastFailureAt']],
    ['stream', ['prepared', 'starts', 'firstFrames', 'failures', 'stops', 'rtcpPackets'],
      ['lastPreparedAt', 'lastStartedAt', 'lastFirstFrameAt', 'lastStoppedAt', 'lastRtcpAt', 'lastFailureAt']],
  ]) {
    const source = value[kind];
    if (!record(source)) continue;
    const section = {};
    for (const key of counters) if (count(source[key])) section[key] = source[key];
    for (const key of timestamps) if (timestamp(source[key])) section[key] = source[key];
    if (source.lastFailure === null || mediaReasons.has(source.lastFailure)) section.lastFailure = source.lastFailure;
    if (kind === 'snapshot' && (source.lastElapsedMs === null || count(source.lastElapsedMs))) section.lastElapsedMs = source.lastElapsedMs;
    if (kind === 'stream' && mediaStreamStates.has(source.state)) section.state = source.state;
    if (Object.keys(section).length) result[kind] = section;
  }
  for (const [kind, allowedStates, counters] of [
    ['audio', ['waiting', 'disabled', 'unavailable', 'starting', 'streaming', 'muted'], ['starts', 'firstFrames', 'failures', 'rtcpPackets']],
    ['talkback', ['idle', 'disabled', 'starting', 'streaming', 'unavailable', 'muted'], ['starts', 'decodedBytes', 'failures']],
  ]) {
    const source = value[kind];
    if (!record(source)) continue;
    const section = {};
    for (const key of ['enabled', 'sourceReceived', 'muted']) if (typeof source[key] === 'boolean') section[key] = source[key];
    for (const key of counters) if (count(source[key])) section[key] = source[key];
    if (allowedStates.includes(source.state)) section.state = source.state;
    if (source.lastFailure === null || mediaReasons.has(source.lastFailure)) section.lastFailure = source.lastFailure;
    if (timestamp(source.lastEventAt)) section.lastEventAt = source.lastEventAt;
    result[kind] = section;
  }
  if (value.lastEvent === null) result.lastEvent = null;
  else if (record(value.lastEvent) && mediaEvents.has(value.lastEvent.type)
    && typeof value.lastEvent.at === 'string' && timestamp(value.lastEvent.at)) {
    const source = value.lastEvent, event = { type: source.type, at: source.at };
    for (const key of ['width', 'height', 'bytes', 'elapsedMs', 'rtcpPackets']) if (count(source[key])) event[key] = source[key];
    if (mediaReasons.has(source.reason)) event.reason = source.reason;
    if (count(source.exitCode) && source.exitCode <= 65535) event.exitCode = source.exitCode;
    if (mediaSignals.has(source.signal)) event.signal = source.signal;
    if (typeof source.cached === 'boolean') event.cached = source.cached;
    result.lastEvent = event;
  }
  return result;
}

/** A deliberately small report suitable for sharing during connection troubleshooting. */
export function safeDiagnostics(value = {}) {
  const result = {};
  if (!record(value)) return result;
  if (states.has(value.state)) result.state = value.state;
  if (reasons.has(value.reason)) result.reason = value.reason;
  if (stages.has(value.stage)) result.stage = value.stage;
  for (const key of ['ready', 'videoReceived', 'paused', 'selected', 'authenticated']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (['cn', 'sg', 'de', 'us', 'ru', 'i2'].includes(value.region)) result.region = value.region;
  for (const key of ['attempt', 'connectingElapsedSeconds', 'retryInSeconds', 'vendor']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= (key === 'vendor' ? 100 : 1000000000)) result[key] = value[key];
  }
  if (value.lastFailure === null || reasons.has(value.lastFailure)) result.lastFailure = value.lastFailure;
  for (const key of ['connectingSince', 'retryAt', 'lastFailureAt']) {
    if (timestamp(value[key])) result[key] = value[key];
  }
  if (record(value.audio)) {
    const audio = {};
    for (const key of ['enabled', 'received', 'talkbackEnabled', 'talkbackSupported']) if (typeof value.audio[key] === 'boolean') audio[key] = value.audio[key];
    if (['PCMA', 'OPUS'].includes(value.audio.codec)) audio.codec = value.audio.codec;
    if ([8000, 16000, 48000].includes(value.audio.sampleRate)) audio.sampleRate = value.audio.sampleRate;
    if ([1, 2].includes(value.audio.channels)) audio.channels = value.audio.channels;
    result.audio = audio;
  }
  if (record(value.matter)) {
    const matter = safeMatterStatus(value.matter);
    if (Object.keys(matter).length) result.matter = matter;
  }
  if (value.media === null) result.media = null;
  else if (record(value.media)) {
    const media = safeMediaDiagnostics(value.media);
    if (Object.keys(media).length) result.media = media;
  }
  return result;
}
