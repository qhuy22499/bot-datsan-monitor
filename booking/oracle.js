// PoC 03-B E2E oracle: independent, read-only DOM verification.
// Approved booking fields are returned for private in-memory comparison only.
// Never print this result, capture HTML/screenshots, or inspect input values/storage.
(() => {
    const report = {
        oracle_version: 'poc03b-oracle-v1',
        state: 'NOT_VERIFIED',
        header_count: 0,
        source_row_count: 0,
        rows: [],
        counters: [],
        previous_candidate_count: 0,
        next_candidate_count: 0
    };
    const fail = () => ({...report, state: 'STRUCTURE_ERROR', rows: []});
    try {
        if (location.origin !== 'https://rsv.shisetsu.city.katsushika.lg.jp') return report;
        const shown = node => Boolean(node && node.getClientRects().length > 0
            && getComputedStyle(node).visibility !== 'hidden');
        const tidy = value => (value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
        const nodes = selector => Array.from(document.querySelectorAll(selector)).filter(shown);
        const labels = node => [
            tidy(node.innerText), tidy(node.getAttribute('aria-label')),
            ...Array.from(node.querySelectorAll('img')).filter(shown).map(image => tidy(image.alt))
        ];
        const controls = nodes('a, button, [role="button"]');
        if (!controls.some(control => labels(control).includes('ログアウト'))
            || shown(document.getElementById('userId'))
            || shown(document.getElementById('password'))) return report;
        if (nodes('[role="alert"], .error, .errorMessage, .errormessage, .errmsg, .error-message')
            .some(node => Boolean(tidy(node.innerText)))) return report;
        if (nodes('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], '
            + 'input[name*="captcha" i], input[id*="captcha" i], '
            + 'iframe[title*="recaptcha" i], iframe[title*="hcaptcha" i], '
            + 'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]')
            .some(node => node.type !== 'hidden')) return report;
        if (nodes('label, h1, h2, h3').some(node =>
            /ワンタイムパスワード|認証コード|確認コード|画像認証|CAPTCHA/i.test(node.innerText || ''))) return report;
        if (!nodes('h1, h2, h3, [role="heading"], caption, b, strong, td, th')
            .some(node => tidy(node.textContent) === '予約一覧')) return report;

        const columns = ['予約番号', '利用日', '時間', '館', '施設'];
        const rowCells = row => Array.from(row.children).filter(node =>
            ['TD', 'TH'].includes(node.tagName) && shown(node));
        const ownRows = table => Array.from(table.querySelectorAll('tr'))
            .filter(row => row.closest('table') === table && shown(row));
        const matches = [];
        for (const table of nodes('table')) {
            const rows = ownRows(table);
            rows.forEach((row, index) => {
                const header = rowCells(row).map(cell => tidy(cell.textContent));
                if (columns.every(label => header.includes(label))) matches.push({table, rows, index, header});
            });
        }
        if (matches.length !== 1) return fail();
        const match = matches[0];
        const headerCells = rowCells(match.rows[match.index]);
        report.header_count = headerCells.length;
        if (headerCells.some(cell => cell.rowSpan !== 1 || cell.colSpan !== 1)
            || new Set(match.header).size !== match.header.length) return fail();
        const sourceRows = match.rows.slice(match.index + 1);
        report.source_row_count = sourceRows.length;
        const payments = new Set(['支払前', '支払済', '支払済み', '支払い済み', '未払い', '入金済', '未入金']);

        const parseDate = text => {
            const value = tidy(text);
            const found = value.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(?:[日月火水木金土]曜日|[日月火水木金土]|\([日月火水木金土](?:曜日)?\)))?$/)
                || value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!found) return null;
            const [year, month, day] = found.slice(1).map(Number);
            const date = new Date(0);
            date.setUTCHours(0, 0, 0, 0);
            date.setUTCFullYear(year, month - 1, day);
            if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
                || date.getUTCDate() !== day) return null;
            return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        };
        const parseTime = text => {
            const value = tidy(text).replace(/\s+/g, '');
            const pair = value.split(/[~〜～\-－]/);
            if (pair.length !== 2) return null;
            const parts = pair.map(part => part.match(/^(\d{1,2})(?:時(\d{1,2})分|:(\d{2}))$/));
            if (parts.some(part => part === null)) return null;
            const clock = parts.map(part => [Number(part[1]), Number(part[2] === undefined ? part[3] : part[2])]);
            if (clock.some(([hour, minute]) => hour < 0 || hour > 23 || minute < 0 || minute > 59)
                || clock[0][0] * 60 + clock[0][1] >= clock[1][0] * 60 + clock[1][1]) return null;
            return clock.map(([hour, minute]) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
        };

        for (let index = 0; index < sourceRows.length; index += 1) {
            const cells = rowCells(sourceRows[index]);
            if (cells.length !== headerCells.length || cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1
                || cell.querySelector('table, input, select, textarea, iframe'))) return fail();
            const read = label => {
                const position = match.header.indexOf(label);
                return position < 0 ? '' : tidy(cells[position].innerText);
            };
            const reservationNumber = read('予約番号');
            const usageDate = parseDate(read('利用日'));
            const times = parseTime(read('時間'));
            const payment = read('支払状況');
            if ((reservationNumber && !/^\d{1,40}$/.test(reservationNumber)) || !usageDate || !times
                || (payment && !payments.has(payment))) return fail();
            const facility = read('館') === '小菅西フットサル場' ? '小菅西フットサル場' : 'OTHER_FACILITY';
            const courtLabel = read('施設');
            const court = courtLabel === 'フットサル場A' ? 'A' : courtLabel === 'フットサル場B' ? 'B' : 'OTHER_COURT';
            report.rows.push({
                source_row_index: index + 1,
                reservation_number: reservationNumber || null,
                facility,
                court,
                usage_date: usageDate,
                start_time: times[0],
                end_time: times[1],
                payment_raw: payment || null
            });
        }

        const knownCounters = new Set();
        for (const node of nodes('p, span, b, strong, font, td, th')) {
            if (match.table.contains(node) || node.querySelector('table, script, style, input, select, textarea')) continue;
            const text = tidy(node.innerText);
            if (text.length > 160) continue;
            const triple = text.match(/^(\d+)件中\s*(\d+)\s*[~〜～\-－]\s*(\d+)件表示(?:\s|$)/);
            if (!triple) continue;
            const [total, first, last] = triple.slice(1).map(Number);
            if (![total, first, last].every(Number.isSafeInteger) || first > last || last > total
                || (total > 0 && first < 1) || (total === 0 && (first !== 0 || last !== 0))) continue;
            const key = [total, first, last].join(':');
            if (!knownCounters.has(key)) {
                knownCounters.add(key);
                report.counters.push({total, first, last});
            }
        }
        const pager = controls.filter(control => !match.table.contains(control));
        report.previous_candidate_count = pager.filter(control => labels(control).includes('前へ')).length;
        report.next_candidate_count = pager.filter(control => labels(control).includes('次へ')).length;
        report.state = 'READY';
        return report;
    } catch {
        return fail();
    }
})()
