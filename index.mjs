import { MijiaRemoteCameraPlatform, PLUGIN_NAME, PLATFORM_NAME } from './lib/platform.mjs';
export default (api) => api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MijiaRemoteCameraPlatform);
