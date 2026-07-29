// api/result.js — Vercel Serverless Function
// بيجيب النتيجة من موقع وزارة التربية والتعليم رسمياً

const BASE_URL = 'https://g12.emis.gov.eg';

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Google Chrome";v="126", "Chromium";v="126"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
};

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { seatNo, track } = req.body || {};
    if (!seatNo || seatNo.trim().length < 4) {
        return res.status(400).json({ error: 'رقم الجلوس مطلوب' });
    }

    const cleanSeatNo = seatNo.trim();

    try {
        // ─── الخطوة 1: جلب الصفحة و استخراج التوكن ───
        const getRes = await fetch(BASE_URL, {
            headers: {
                ...BROWSER_HEADERS,
                'Referer': 'https://www.google.com/',
            },
        });

        const html = await getRes.text();

        // استخراج __RequestVerificationToken
        let token = null;
        const patterns = [
            /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i,
            /name="__RequestVerificationToken"[^>]*?value="([^"]+)"/i,
            /__RequestVerificationToken[^=]*?=\s*["']([^"']+)["']/i,
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                token = match[1];
                break;
            }
        }

        if (!token) {
            // لو مش لاقي التوكن، جرب نستخدم API مختلف
            return res.status(200).json({
                error: 'مؤقتاً، الموقع الرسمي للوزارة هو المصدر الوحيد.',
                fallbackUrl: BASE_URL
            });
        }

        // ─── الخطوة 2: إرسال رقم الجلوس ───
        const formData = new URLSearchParams();
        formData.append('SeatingNo', cleanSeatNo);
        formData.append('__RequestVerificationToken', token);

        const postRes = await fetch(BASE_URL, {
            method: 'POST',
            headers: {
                ...BROWSER_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': BASE_URL,
                'Origin': BASE_URL,
            },
            body: formData.toString(),
        });

        const resultHtml = await postRes.text();

        // ─── الخطوة 3: تحليل الـ HTML لاستخراج البيانات ───
        const result = parseResultHtml(resultHtml, cleanSeatNo, track);
        
        // لو النتيجة مش موجودة — جرب نبحث تاني
        if (!result.found) {
            return res.status(200).json({
                found: false,
                message: 'لم يتم العثور على نتيجة بهذا الرقم. تأكد من صحة رقم الجلوس.'
            });
        }

        return res.status(200).json(result);

    } catch (error) {
        console.error('API Error:', error);
        return res.status(200).json({
            found: false,
            error: 'عذراً، حدث خطأ في الاتصال بخادم الوزارة. جرب الموقع الرسمي.',
            fallbackUrl: BASE_URL
        });
    }
}

function parseResultHtml(html, seatNo, track) {
    // دوال مساعدة للاستخراج
    const extract = (regex, group = 1) => {
        const m = html.match(regex);
        return m ? m[group].trim() : null;
    };

    // استخراج الاسم
    const name = extract(/<td[^>]*>\s*الاسم\s*(?:\u0627\u0644\u0637\u0627\u0644\u0628)?\s*<\/td>\s*<td[^>]*>([^<]+)</i)
              || extract(/الاسم[^:]*:\s*([^<]+)/i)
              || extract(/student-name[^>]*>([^<]+)/i);

    // استخراج المدرسة
    const school = extract(/<td[^>]*>\s*المدرسة\s*<\/td>\s*<td[^>]*>([^<]+)</i)
                || extract(/المدرسة[^:]*:\s*([^<]+)/i);

    // استخراج المجموع
    const totalStr = extract(/<td[^>]*>\s*المجموع\s*(?:الكلي)?\s*<\/td>\s*<td[^>]*>([^<]+)</i)
                   || extract(/المجموع[^:]*:\s*([^<]+)/i)
                   || extract(/(\d{3}\.\d{1,2})/);

    let total = totalStr || '—';
    let percent = '—';

    if (total !== '—') {
        // المجموع الكلي للثانوية العامة 410 درجة
        const numTotal = parseFloat(total);
        if (!isNaN(numTotal) && numTotal > 0) {
            percent = ((numTotal / 410) * 100).toFixed(2) + '%';
        }
    }

    // استخراج الحالة
    const statusText = extract(/<td[^>]*>\s*الحالة\s*<\/td>\s*<td[^>]*>([^<]+)</i)
                     || extract(/الحالة[^:]*:\s*([^<]+)/i)
                     || extract(/(ناجح|ناجحة|دور ثان|راسب|ضعيف)/i);

    let status = statusText || 'تم الاستعلام';

    // استخراج المواد ودرجاتها
    const subjects = [];
    
    // محاولة استخراج جدول المواد
    const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/gi);
    if (tableMatch) {
        for (const table of tableMatch) {
            const rows = table.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
            if (rows) {
                for (const row of rows) {
                    const cells = row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi);
                    if (cells && cells.length >= 2) {
                        const nameCell = cells[0].replace(/<[^>]+>/g, '').trim();
                        const gradeCell = cells[1].replace(/<[^>]+>/g, '').trim();
                        if (nameCell && gradeCell && isNaN(nameCell) && nameCell.length > 2) {
                            subjects.push({ name: nameCell, grade: gradeCell });
                        }
                    }
                }
            }
        }
    }

    // لو ملقتش جدول، جرب استخراج من قائمة
    if (subjects.length === 0) {
        const listItems = html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
        if (listItems) {
            for (const item of listItems) {
                const text = item.replace(/<[^>]+>/g, '').trim();
                const parts = text.split(/[:-]/);
                if (parts.length >= 2 && parts[0].trim().length > 2) {
                    const grade = parts[parts.length - 1].trim();
                    const subName = parts.slice(0, -1).join(':').trim();
                    if (subName && grade && !isNaN(grade) && !subName.includes('رقم')) {
                        subjects.push({ name: subName, grade });
                    }
                }
            }
        }
    }

    // هل لقينا نتيجة ولا لأ؟
    const found = !!(name || total !== '—' || subjects.length > 0);

    return {
        found,
        seatNo,
        name: name || 'لم يتم العثور على الاسم',
        school: school || '—',
        total,
        percent,
        track: track || '—',
        status,
        subjects: subjects.length > 0 ? subjects.slice(0, 20) : [],
        raw: html.substring(0, 500) // لل debugging لو احتجنا
    };
}