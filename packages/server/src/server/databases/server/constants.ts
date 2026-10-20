
export enum AutoStartMethods {
    None = "none",
    Unset = "unset",
    LoginItem = "login-item",
    LaunchAgent = "launch-agent"
}

export enum ProxyServices {
    Cloudflare = "cloudflare",
    Ngrok = "ngrok",
    Zrok = "zrok",
    DynamicDNS = "dynamic-dns",
    LanURL = "lan-url"
}

export const DEFAULT_SOCKET_PORT = 1234;
export const DEFAULT_DB_ITEMS: { [key: string]: () => any } = {
    tutorial_is_done: () => 0,
    socket_port: () => DEFAULT_SOCKET_PORT,
    server_address: () => "",
    ngrok_key: () => "",
    ngrok_protocol: () => "http",
    ngrok_region: () => "us",
    ngrok_custom_domain: () => "",
    use_custom_certificate: () => 0,
    password: () => "",
    auto_caffeinate: () => 0,
    auto_start: () => 0,
    auto_start_method: () => AutoStartMethods.None,
    proxy_service: () => ProxyServices.Cloudflare,
    encrypt_coms: () => 0,
    hide_dock_icon: () => 0,
    last_fcm_restart: () => 0,
    start_via_terminal: () => 0,
    check_for_updates: () => 1,
    auto_install_updates: () => 0,
    enable_private_api: () => 0,
    enable_ft_private_api: () => 0,
    use_oled_dark_mode: () => 0,
    db_poll_interval: () => 1000,
    dock_badge: () => 1,
    start_minimized: () => 0,
    headless: () => 0,
    disable_gpu: () => 0,
    private_api_mode: (): "process-dylib" => "process-dylib",
    // String because we don't handle actual integers well.
    // That needs to change... at another time.
    // 0.0 to prevent parsing as a boolean
    start_delay: () => "0.0",
    facetime_calling: () => 0,
    zrok_token: () => "",
    zrok_reserve_tunnel: () => 0,
    zrok_reserved_name: () => "",
    zrok_reserved_token: () => "",
    landing_page_path: () => "",
    open_findmy_on_startup: () => 1,
    auto_lock_mac: () => 0,
    // Echo Server
    echo_lean_applied: () => 0,
    echo_guard: () => 1,
    echo_address_fallback: () => "",
    echo_nightly_restart: () => 1,
    // Strings so they aren't read back as booleans (see start_delay).
    echo_server_limit_mb: () => "900",
    echo_messages_limit_mb: () => "1400",
    echo_min_free_gb: () => "10",
    // Anthropic API key for Catch me up; set from the phone, never sent back out.
    echo_anthropic_key: () => "",
    echo_clipboard_sync: (): boolean => false,
    echo_auto_codes: (): boolean => true,
    echo_phone_notifications_mac: (): boolean => true,
    // Backups to the PC: the key (made on first use, never sent to the PC) and when one last finished.
    echo_backup_key: () => "",
    echo_backup_last: () => "0",
};
