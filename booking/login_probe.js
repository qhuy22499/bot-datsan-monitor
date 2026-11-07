// Chỉ đọc DOM và trả boolean. Có thể chạy trong Console của phiên đang mở.
// Không đọc value, hidden input, cookie, storage hoặc URL; không click/submit.
(() => {
    const flags = {
        trusted_origin: location.origin === 'https://rsv.shisetsu.city.katsushika.lg.jp',
        id_field_visible: false,
        password_field_visible: false,
        logout_control_visible: false,
        reservation_heading_visible: false,
        reservation_columns_visible: false,
        error_region_visible: false,
        verification_prompt_visible: false
    };
    if (!flags.trusted_origin) return flags;
    const visible = element => element
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
    const normal = text => (text || '').replace(/\s+/g, ' ').trim();
    const elements = selector => [...document.querySelectorAll(selector)].filter(visible);
    flags.id_field_visible = Boolean(visible(document.getElementById('userId')));
    flags.password_field_visible = Boolean(visible(document.getElementById('password')));
    flags.logout_control_visible = elements('a, button, [role="button"]').some(element =>
        normal(element.textContent) === 'ログアウト'
        || element.getAttribute('aria-label') === 'ログアウト'
        || [...element.querySelectorAll('img')].some(image => image.alt === 'ログアウト')
    );

    // Ảnh thực tế có tiêu đề 予約一覧; chưa biết nó dùng heading hay ô bảng.
    flags.reservation_heading_visible = elements(
        'h1, h2, h3, [role="heading"], caption, b, strong, td, th'
    ).some(element => normal(element.textContent) === '予約一覧');

    // Các cột đúng như giao diện: 時間, không phải 利用時間/使用時間.
    // Nhận TH hoặc TD; không gộp nhãn từ nhiều hàng/bảng con khác nhau.
    const requiredHeaders = ['予約番号', '利用日', '時間', '館', '施設'];
    flags.reservation_columns_visible = elements('table').some(table =>
        [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table)
            .some(row => {
                const headers = [...row.children]
                    .filter(cell => ['TH', 'TD'].includes(cell.tagName) && visible(cell))
                    .map(cell => normal(cell.textContent));
                return requiredHeaders.every(header => headers.includes(header));
            })
    );
    flags.error_region_visible = elements(
        '[role="alert"], .error, .errorMessage, .errormessage, .errmsg, .error-message'
    ).some(element => Boolean(normal(element.textContent)));
    flags.verification_prompt_visible = elements(
        'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], '
        + 'input[name*="captcha" i], input[id*="captcha" i], '
        + 'iframe[title*="recaptcha" i], iframe[title*="hcaptcha" i], '
        + 'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]'
    ).some(element => element.type !== 'hidden') || elements('label, h1, h2, h3').some(element =>
        /ワンタイムパスワード|認証コード|確認コード|画像認証|CAPTCHA/i.test(element.textContent || '')
    );
    return flags;
})()
