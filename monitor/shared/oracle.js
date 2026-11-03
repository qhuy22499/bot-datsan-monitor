// Oracle E2E READ_ONLY: chỉ bảng public, không click/value/cookie/storage/URL động.
(() => {
    if (location.origin !== 'https://rsv.shisetsu.city.katsushika.lg.jp') return {verified: false};
    const tables = [...document.querySelectorAll('table.akitablelist')];
    if (tables.length !== 1 || tables[0].rows.length !== 3) return {verified: false};
    const rows = [...tables[0].rows];
    const normal = text => (text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const day = normal(rows[0].innerText).match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    if (!day) return {verified: false};
    // Thứ tự bảy khung giờ của grid PoC02 đã PASS, không lấy từ reader Python.
    const times = [['08:00','10:00'],['10:00','12:00'],['12:00','14:00'],
        ['14:00','16:00'],['16:00','18:00'],['18:30','20:30'],['20:30','22:30']];
    const date = `${day[1]}-${day[2].padStart(2,'0')}-${day[3].padStart(2,'0')}`;
    const slots = [];
    for (const row of rows.slice(1)) {
        const label = normal(row.querySelector('th')?.innerText);
        if (!['フットサル場A','フットサル場B'].includes(label)) return {verified: false};
        const images = [...row.querySelectorAll('td img')];
        if (images.length !== 7) return {verified: false};
        images.forEach((img, i) => {
            const file = (img.getAttribute('src') || '').split('?')[0].split('/').pop().toLowerCase();
            // Oracle độc lập, đối chiếu hàng icon–mô tả trong Help chính thức.
            const status = ({'lw_emptybs.gif':'AVAILABLE','lw_210.gif':'GENERAL_RESERVED','lw_finishs.gif':'GENERAL_RESERVED',
                'lw_211.gif':'TOURNAMENT_RESERVED','lw_212.gif':'EVENT_RESERVED','lw_213.gif':'OTHER_RESERVED',
                'lw_214.gif':'COMMUNITY_RESERVED','lw_closes.gif':'CLOSED','lw_keeps.gif':'MAINTENANCE',
                'lw_akuten.gif':'BAD_WEATHER','lw_kikangais.gif':'OUTSIDE_ACCEPTANCE_PERIOD',
                'lw_900.gif':'UNSELECTABLE','lw_notime.gif':'UNBOOKABLE_TIME'})[file] || 'UNKNOWN';
            slots.push({date, court: label.slice(-1), start: times[i][0], end: times[i][1], status});
        });
    }
    return {verified: true, date, slots};
})()
