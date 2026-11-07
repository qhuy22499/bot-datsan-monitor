// PoC 03-B: chỉ đọc DOM trong Page do Playwright đang quản lý.
// Không click/submit, đọc value/cookie/storage, chụp ảnh hoặc xuất HTML/URL.
// Chỉ trả trường lịch được cho phép; Python kiểm tra ngày, giờ và độ đầy đủ.
(() => {
    const report = {
        snapshot_version: 'poc03b-extract-v1',
        state: 'SNAPSHOT_INVALID',
        auth: {
            trusted_origin: false,
            id_field_visible: false,
            password_field_visible: false,
            logout_control_visible: false,
            reservation_heading_visible: false,
            reservation_columns_visible: false,
            error_region_visible: false,
            verification_prompt_visible: false
        },
        title_visible: false,
        table_count: 0,
        header_valid: false,
        source_row_count: 0,
        rejected_row_count: 0,
        rows: [],
        pagination: {
            summaries: [],
            summary_conflict: false,
            previous_candidate_count: 0,
            next_candidate_count: 0
        },
        issues: []
    };
    const issue = code => {
        if (!report.issues.includes(code)) report.issues.push(code);
    };
    const stop = code => {
        report.state = code;
        issue(code);
        return report;
    };
    try {
        const visible = element => Boolean(element && element.getClientRects().length
            && getComputedStyle(element).visibility !== 'hidden');
        const normal = text => (text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
        const elements = selector => [...document.querySelectorAll(selector)].filter(visible);
        const ownRows = table => [...table.querySelectorAll('tr')]
            .filter(row => row.closest('table') === table && visible(row));
        const cells = row => [...row.children]
            .filter(cell => ['TH', 'TD'].includes(cell.tagName) && visible(cell));
        const cleanCell = cell => !cell.querySelector('table, input, select, textarea, script, style')
            && cell.colSpan === 1 && cell.rowSpan === 1;
        const labels = control => [
            normal(control.innerText), normal(control.getAttribute('aria-label')),
            ...[...control.querySelectorAll('img')].filter(visible).map(image => normal(image.alt))
        ];

        report.auth.trusted_origin = location.origin === 'https://rsv.shisetsu.city.katsushika.lg.jp';
        if (!report.auth.trusted_origin) return stop('SESSION_NOT_VERIFIED');
        report.auth.id_field_visible = visible(document.getElementById('userId'));
        report.auth.password_field_visible = visible(document.getElementById('password'));
        const controls = elements('a, button, [role="button"]');
        report.auth.logout_control_visible = controls.some(control => labels(control).includes('ログアウト'));
        report.auth.error_region_visible = elements(
            '[role="alert"], .error, .errorMessage, .errormessage, .errmsg, .error-message'
        ).some(element => Boolean(normal(element.innerText)));
        report.auth.verification_prompt_visible = elements(
            'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], '
            + 'input[name*="captcha" i], input[id*="captcha" i], '
            + 'iframe[title*="recaptcha" i], iframe[title*="hcaptcha" i], '
            + 'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]'
        ).some(element => element.type !== 'hidden') || elements('label, h1, h2, h3').some(element =>
            /ワンタイムパスワード|認証コード|確認コード|画像認証|CAPTCHA/i.test(element.textContent || '')
        );
        if (report.auth.verification_prompt_visible) return stop('VERIFICATION_REQUIRED');
        if (report.auth.error_region_visible) return stop('WEBSITE_ERROR');
        if (!report.auth.logout_control_visible || report.auth.id_field_visible
            || report.auth.password_field_visible) return stop('SESSION_NOT_VERIFIED');

        report.title_visible = elements('h1, h2, h3, [role="heading"], caption, b, strong, td, th')
            .some(element => normal(element.textContent) === '予約一覧');
        report.auth.reservation_heading_visible = report.title_visible;
        const required = ['予約番号', '利用日', '時間', '館', '施設'];
        const statusHeaders = ['予約状況', '予約状態', '状態', '状況', '申込状況', '抽選結果', '当落', '利用状況'];
        const paymentHeaders = ['支払状況', '支払い状況', '入金状況'];
        const matches = [];
        for (const table of elements('table')) {
            const rows = ownRows(table);
            const headers = rows.map((row, index) => ({row, index, names: cells(row).map(cell => normal(cell.textContent))}))
                .filter(header => required.every(name => header.names.includes(name)));
            if (headers.length) matches.push({table, rows, headers});
        }
        report.table_count = matches.length;
        report.auth.reservation_columns_visible = matches.length > 0;
        if (!report.title_visible || !matches.length) return stop('TABLE_NOT_READY');
        if (matches.length !== 1 || matches[0].headers.length !== 1) return stop('AMBIGUOUS_TABLE_STRUCTURE');
        const target = matches[0];
        const header = target.headers[0];
        const headerCells = cells(header.row);
        const selectedLabels = [...required, ...statusHeaders, ...paymentHeaders];
        if (selectedLabels.some(name => header.names.filter(label => label === name).length > 1)
            || statusHeaders.filter(name => header.names.includes(name)).length > 1
            || paymentHeaders.filter(name => header.names.includes(name)).length > 1) {
            return stop('AMBIGUOUS_TABLE_STRUCTURE');
        }
        if (header.index !== 0 || !headerCells.every(cleanCell)) return stop('UNSUPPORTED_TABLE_STRUCTURE');
        report.header_valid = true;

        const pagerLabels = {previous_candidate_count: ['前へ', '前のページ'], next_candidate_count: ['次へ', '次のページ']};
        for (const [key, allowed] of Object.entries(pagerLabels)) {
            report.pagination[key] = controls.filter(control => !target.table.contains(control)
                && labels(control).some(label => allowed.includes(label))).length;
        }
        const seenSummaries = new Set();
        for (const element of elements('p, span, b, strong, font, td, th')) {
            if (target.table.contains(element)
                || element.querySelector('table, script, style, input, select, textarea')) continue;
            const text = normal(element.innerText);
            if (text.length > 160) continue;
            const match = text.match(/^(\d+)件中\s*(\d+)\s*[〜～~\-－]\s*(\d+)件表示(?:\s|$)/);
            if (!match) continue;
            const [total, first, last] = match.slice(1).map(Number);
            const valid = [total, first, last].every(Number.isSafeInteger)
                && ((total === 0 && first === 0 && last === 0)
                    || (total > 0 && first >= 1 && first <= last && last <= total));
            if (!valid) {
                issue('COUNTER_MISMATCH');
                continue;
            }
            const key = `${total}:${first}:${last}`;
            if (!seenSummaries.has(key)) {
                seenSummaries.add(key);
                report.pagination.summaries.push({total, first, last});
            }
        }
        report.pagination.summary_conflict = report.pagination.summaries.length > 1;
        if (report.pagination.summary_conflict) issue('COUNTER_CONFLICT');
        if (!report.pagination.summaries.length) issue('COUNTER_MISSING');

        const reservationTokens = new Set([
            '確定', '予約確定', '予約済', '確認済', '承認済', '仮予約', '未確定', '承認待ち',
            '確認待ち', '申込中', '取消', '取消済', '取消済み', 'キャンセル', 'キャンセル済',
            '抽選申込', '抽選待ち', '抽選中', '当選', '落選', '未抽選', '申請中', '審査中'
        ]);
        const paymentTokens = new Set(['支払前', '支払済', '支払済み', '支払い済み', '未払い', '入金済', '未入金']);
        const indexOf = name => header.names.indexOf(name);
        const statusIndex = statusHeaders.map(indexOf).find(index => index >= 0);
        const paymentIndex = paymentHeaders.map(indexOf).find(index => index >= 0);
        const status = (rowCells, index, allowed) => {
            if (index === undefined) return null;
            const text = normal(rowCells[index].innerText);
            if (!text) return null;
            if (allowed.has(text)) return text;
            issue('UNSUPPORTED_STATUS');
            return null;
        };
        const rows = target.rows.slice(header.index + 1);
        report.source_row_count = rows.length;
        rows.forEach((row, offset) => {
            const rowCells = cells(row);
            if (rowCells.length !== headerCells.length || !rowCells.every(cleanCell)) {
                report.rejected_row_count += 1;
                issue('ROW_REJECTED');
                issue('UNSUPPORTED_TABLE_STRUCTURE');
                return;
            }
            const text = name => normal(rowCells[indexOf(name)].innerText);
            const number = text('予約番号');
            const usageDate = text('利用日');
            const time = text('時間');
            let invalid = false;
            if (number && !/^\d{1,40}$/.test(number)) {
                issue('UNSUPPORTED_RESERVATION_NUMBER');
                invalid = true;
            }
            if (!/^(?:\d{4}年\s*\d{1,2}月\s*\d{1,2}日(?:\s*(?:[月火水木金土日]曜日|\([月火水木金土日](?:曜日)?\)))?|\d{4}-\d{2}-\d{2})$/.test(usageDate)) {
                issue('UNSUPPORTED_DATE');
                invalid = true;
            }
            if (!/^(?:\d{1,2}時\s*\d{1,2}分|\d{1,2}:\d{2})\s*[〜～~\-－]\s*(?:\d{1,2}時\s*\d{1,2}分|\d{1,2}:\d{2})$/.test(time)) {
                issue('UNSUPPORTED_TIME');
                invalid = true;
            }
            if (invalid) {
                report.rejected_row_count += 1;
                issue('ROW_REJECTED');
                return;
            }
            const facility = text('館');
            const court = text('施設');
            report.rows.push({
                source_row_index: offset + 1,
                reservation_number: number || null,
                facility: facility === '小菅西フットサル場' ? facility : 'OTHER_FACILITY',
                court_label: ['フットサル場A', 'フットサル場B'].includes(court) ? court : 'OTHER_COURT',
                usage_date_text: usageDate,
                time_text: time,
                reservation_status_raw: status(rowCells, statusIndex, reservationTokens),
                payment_status_raw: status(rowCells, paymentIndex, paymentTokens)
            });
        });
        report.state = 'READY';
        return report;
    } catch {
        // Không trả exception: thông báo của trình duyệt có thể chứa dữ liệu trang.
        report.rows = [];
        return stop('SNAPSHOT_INVALID');
    }
})()
