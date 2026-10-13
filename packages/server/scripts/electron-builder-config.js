// NOTE: All paths are relative to the package.json that will be loading this configuration file.
// Making them relative to the scripts folder will break the commands
module.exports = {
    "productName": "Echo Server",
    "appId": "com.echo.server-app",
    "npmRebuild": true,
    "directories": {
        "output": "releases",
        "buildResources": "appResources"
    },
    "asar": true,
    "extraResources": [
        "appResources"
    ],
    "mac": {
        "category": "public.app-category.social-networking",
        "target": [
            {
                "target": "dmg",
                "arch": [
                    "x64",
                    "arm64"
                ],
            }
        ],
        "type": "distribution",
        "icon": "../../icons/macos/dock-icon.png",
        "darkModeSupport": true,
        "hardenedRuntime": true,
        "notarize": false,
        "entitlements": "./scripts/entitlements.mac.plist",
        "entitlementsInherit": "./scripts/entitlements.mac.plist",
        "extendInfo": {
            "NSContactsUsageDescription": "Echo Server shows your contacts' names and photos in the Echo apps",
            "NSAppleEventsUsageDescription": "Echo Server uses AppleScript to send messages and keep Messages running",
            "NSSystemAdministrationUsageDescription": "Echo Server needs this to keep your Mac awake and restart itself",
        },
        "gatekeeperAssess": false,
        "minimumSystemVersion": "10.11.0",
        "signIgnore": [
            "ngrok$",
            "zrok$",
            "cloudflared$"
        ],
    },
    "dmg": {
        "sign": false,
        "writeUpdateInfo": false
    },
    // "afterSign": "./scripts/notarize.js"
};
