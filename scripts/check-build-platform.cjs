// electron-builder's macOS uninstaller extraction produced invalid NSIS files.
// Build Windows installers on Windows so NSIS generates its own uninstaller.
module.exports = async function (context) {
  if (context.electronPlatformName === 'win32' && process.platform !== 'win32') {
    throw new Error('Windows installers must be built on Windows. Cross-building on macOS produced an invalid uninstaller.');
  }
};
