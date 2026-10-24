const STATES = new Set(['disabled', 'starting', 'ready', 'failed', 'stopped']);
const REASONS = new Set(['matter_disabled', 'matter_not_ready', 'matter_start_failed', 'matter_port_in_use',
  'matter_configuration_invalid', 'matter_pairing_unavailable', 'matter_window_failed', 'matter_closed']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function safeMatterStatus(value = {}) {
  if (!object(value)) return {};
  const result = {};
  for (const key of ['enabled', 'running', 'commissioned', 'commissioningWindowOpen']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (STATES.has(value.state)) result.state = value.state;
  if (REASONS.has(value.reason)) result.reason = value.reason;
  if (value.deviceType === 322) result.deviceType = 322;
  for (const key of ['activeSessions', 'videoStreams', 'audioStreams', 'snapshotStreams']) {
    if (count(value[key]) && value[key] <= 100) result[key] = value[key];
  }
  const source = value.media;
  if (object(source)) {
    const media = {};
    for (const key of ['sessions', 'failures', 'videoPackets', 'audioPackets', 'talkPackets', 'talkBytes', 'activeSessions', 'maxSessions', 'activeSources', 'videoSources', 'audioSources', 'sourceJobs', 'sourceSockets']) {
      if (count(source[key])) media[key] = source[key];
    }
    for (const key of ['active', 'microphoneMuted', 'speakerMuted', 'talkbackActive']) if (typeof source[key] === 'boolean') media[key] = source[key];
    for (const [key, allowed] of Object.entries({"lastFailure": ["negotiation_failed", "media_not_offered", "webrtc_timeout", "webrtc_failed", "webrtc_disconnected", "media_unavailable", "udp_error", "ffmpeg_unavailable", "ffmpeg_exit", "video_timeout"], "lastFailureStage": ["remote_description", "replace_video_track", "replace_audio_track", "create_answer", "create_offer", "local_description", "remote_answer"], "lastFailureType": ["Error", "TypeError", "RangeError", "OperationError", "InvalidStateError", "InvalidModificationError", "InvalidAccessError", "NotSupportedError", "SyntaxError", "AbortError"]})) {
      if (allowed.includes(source[key])) media[key] = source[key];
    }
    if (Object.keys(media).length) result.media = media;
  }
  return result;
}

