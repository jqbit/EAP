// Spawn options for the upstream MCP child process.
// Windows needs shell:true so .cmd shims resolve via PATHEXT.
// POSIX stays shell:false to avoid argv quoting surprises.

export function getSpawnOptions(platform = process.platform) {
  return {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: platform === 'win32',
    windowsHide: true,
  };
}
