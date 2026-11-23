import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { IncomingMessage, ServerResponse } from 'node:http';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`TIMEOUT (${label} exceeded ${ms}ms)`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const HIJRI_MONTHS_AR = [
  'محرم',
  'صفر',
  'ربيع الأول',
  'ربيع الآخر',
  'جمادى الأولى',
  'جمادى الآخر',
  'رجب',
  'شعبان',
  'رمضان',
  'شوال',
  'ذو القعدة',
  'ذو الحجة',
];

function toEnglishDigits(str: string): string {
  return String(str || '')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function toArabicDigits(str: string | number): string {
  return String(str ?? '').replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
}

function extractFallbackHijriMonthName(title: string, monthKey: string): string {
  const mk = toEnglishDigits(monthKey || '').trim();
  if (/^\d{4}-\d{2}$/.test(mk)) {
    const mIdx = Number(mk.slice(5, 7)) - 1;
    if (mIdx >= 0 && mIdx < 12) return HIJRI_MONTHS_AR[mIdx];
  }
  const t = String(title || '');
  const found = HIJRI_MONTHS_AR.find((m) => t.includes(m));
  return found || '';
}

interface ParsedScheduleRow {
  type?: string;
  dayName?: string;
  hijriText?: string;
  listenText?: string;
  hifzText?: string;
  extraText?: string;
  reviewText?: string;
  freeText?: string;
  mergedText?: string;
}

interface ParsedSchedule {
  title?: string;
  monthKey?: string;
  footerText?: string;
  colListenLabel?: string;
  colHifzLabel?: string;
  extraEnabled?: boolean;
  extraLabel?: string;
  colReviewLabel?: string;
  colFreeLabel?: string;
  rows?: ParsedScheduleRow[];
}

function normalizeParsedSchedule(parsed: ParsedSchedule): ParsedSchedule {
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  const fallbackMonth = extractFallbackHijriMonthName(parsed.title || '', parsed.monthKey || '');
  let currentMonthSuffix = '';
  let prevHijriText = '';

  const dittoOnlyRe = /^(?:\/\/+|\\\\+|""+|''+|"|،،+|〃|=|—|–|-)\s*$/;
  const trailingDittoRe = /(?:\s*(?:\/\/+|\\\\+|""+|''+|"|،،+|〃|\/))+\s*$/;
  const prevColVals: Record<string, string> = {
    listenText: '',
    hifzText: '',
    extraText: '',
    reviewText: '',
    freeText: '',
  };

  const normalizedRows = rows.map((row) => {
    const r = { ...row };
    const rawHijri = toEnglishDigits(r.hijriText || '').trim();
    const cleanedHijri = rawHijri
      .replace(trailingDittoRe, '')
      .replace(/^(\d{1,2})\s*[-–—.]+\s*$/, '$1')
      .trim();

    if (dittoOnlyRe.test(rawHijri) && prevHijriText) {
      r.hijriText = prevHijriText;
    } else if (cleanedHijri) {
      const mDayMonth = cleanedHijri.match(/^(\d{1,2})[\s\-\/]+(?:من\s+)?([\u0600-\u06FF][\u0600-\u06FF\s]*?)(?:\s*[-–—\/]?\s*\d{4})?\s*(?:هـ)?\.?$/);
      const mMonthDay = !mDayMonth
        ? cleanedHijri.match(/^([\u0600-\u06FF][\u0600-\u06FF\s]*?)[\s\-\/]+(\d{1,2})(?:\s*[-–—\/]?\s*\d{4})?\s*(?:هـ)?\.?$/)
        : null;
      const mDayOnly = cleanedHijri.match(/^(\d{1,2})$/);

      if (mDayMonth && mDayMonth[2].trim().length >= 2) {
        const dayNum = mDayMonth[1];
        const monthPart = mDayMonth[2].replace(/\s*هـ\s*$/, '').trim();
        currentMonthSuffix = monthPart;
        r.hijriText = toArabicDigits(`${dayNum} ${monthPart}`);
      } else if (mMonthDay && mMonthDay[1].trim().length >= 2) {
        const monthPart = mMonthDay[1].replace(/\s*هـ\s*$/, '').trim();
        const dayNum = mMonthDay[2];
        currentMonthSuffix = monthPart;
        r.hijriText = toArabicDigits(`${dayNum} ${monthPart}`);
      } else if (mDayOnly) {
        const suffix = currentMonthSuffix || fallbackMonth;
        r.hijriText = toArabicDigits(suffix ? `${mDayOnly[1]} ${suffix}` : mDayOnly[1]);
      } else {
        r.hijriText = toArabicDigits(cleanedHijri);
      }
    } else {
      r.hijriText = '';
    }
    if (r.hijriText) prevHijriText = r.hijriText;

    (['listenText', 'hifzText', 'extraText', 'reviewText', 'freeText'] as const).forEach((col) => {
      const val = String(r[col] || '').trim();
      if (val && /^(?:\/\/|\\\\|""|''|"|،،|〃)$/.test(val) && prevColVals[col]) {
        r[col] = prevColVals[col];
      } else {
        r[col] = toArabicDigits(val);
        if (r[col] && r.type !== 'friday' && r.type !== 'exam') {
          prevColVals[col] = r[col] as string;
        }
      }
    });

    r.dayName = toArabicDigits(String(r.dayName || '').trim());
    r.mergedText = toArabicDigits(String(r.mergedText || '').trim());
    return r;
  });

  return {
    ...parsed,
    title: toArabicDigits(String(parsed.title || '').trim()),
    footerText: toArabicDigits(String(parsed.footerText || '').trim()),
    colListenLabel: toArabicDigits(String(parsed.colListenLabel || '').trim()),
    colHifzLabel: toArabicDigits(String(parsed.colHifzLabel || '').trim()),
    extraLabel: toArabicDigits(String(parsed.extraLabel || '').trim()),
    colReviewLabel: toArabicDigits(String(parsed.colReviewLabel || '').trim()),
    colFreeLabel: toArabicDigits(String(parsed.colFreeLabel || '').trim()),
    rows: normalizedRows,
  };
}

const SCHEDULE_PROMPT = `أنت مساعد خبير في قراءة جداول حفظ ومراجعة القرآن الكريم العربية بدقة تامة (سواء كانت مصممة بالإكسل أو مكتوبة بخط اليد).
اقرأ صورة الجدول المرفقة بالكامل صفاً بصف من الأعلى إلى الأسفل، وفي كل صف اقرأ كل عمود من اليمين إلى اليسار (اتجاه عربي RTL) بدون إهمال أي عمود!

ترتيب الأعمدة المعتاد من اليمين إلى اليسار:
- العمود ١ (أقصى اليمين): اليوم
- العمود ٢: التاريخ الهجري
- العمود ٣: الاستماع (listenText)
- العمود ٤: الحفظ (hifzText) — مثال: "١ : ٤٤ المعارج + نوح" أو "١ : ١٢ الحاقة"
- (اختياري في الجداول ذات ٧ أعمدة فقط) العمود ٥: عمود إضافي مثل السورة/الأنفال (extraText)
- العمود قبل الأخير على اليسار: المراجعة (reviewText) — مثال: "الحزب ٦٠" أو "المعارج + نوح + حزب ٥٩"
- العمود الأخير (أقصى اليسار): قراءة ما تيسر (freeText)

قواعد الدقة الإلزامية:
1. العنوان العلوي (title): مثل "جدول شهر جمادى الآخر ١٤٤٨ هـ".
2. الشهر الهجري (monthKey): استنتج السنة ورقم الشهر بصيغة YYYY-MM بأرقام إنجليزية (مثال: جمادى الآخر ١٤٤٨ هـ = "1448-06"، رجب ١٤٤٨ هـ = "1448-07"). الترتيب الهجري: 01 محرم، 02 صفر، 03 ربيع الأول، 04 ربيع الآخر، 05 جمادى الأولى، 06 جمادى الآخرة/الآخر، 07 رجب، 08 شعبان، 09 رمضان، 10 شوال، 11 ذو القعدة، 12 ذو الحجة. إذا لم يظهر الشهر أعد "".
3. التذييل أسفل الجدول (footerText): مثل "مجموعة تعاهدوا القرآن -٣-".
4. في عمود التاريخ الهجري (hijriText): إذا كُتب في صف رقم اليوم ومعه اسم الشهر مثل "١ جمادى الأول" أو "1 جمادي الاول"، ثم كُتبت في الصفوف التالية أرقام الأيام فقط بدون تكرار اسم الشهر (مثل "٢"، "٣"، "٤" أو مع علامة تكرار // أو ")، أكمل اسم الشهر في كل صف تالٍ تلقائياً (مثل "٢ جمادى الأول"، "٣ جمادى الأول"، "٤ جمادى الأول"...) وهكذا حتى يظهر اسم شهر جديد في الجدول فاعتمد الشهر الجديد للصفوف التي تليه.
5. لا تدمج نص عمودين معاً ولا تتخطَّ عمود الحفظ (hifzText) أو عمود المراجعة (reviewText) أبداً!
6. اقرأ جميع الأيام من اليوم الأول إلى آخر يوم دون حذف أي صف.
7. إذا ظهرت علامة التكرار // أو " في أي خلية (خصوصاً بخط اليد)، كرر نفس نص الخلية التي فوقها مباشرة في نفس العمود.
8. يوم الجمعة أو الصف المدمج الذي يحتوي "قراءة سورة الكهف": type = "friday"، وضع النص في mergedText.
9. الصف الأحمر أو الصف الذي فيه "إختبار" / "اختبار": type = "exam"، وضع النص كاملاً في mergedText.
10. الصف الذي فيه الاستماع في عموده وباقي الخلايا الوسطى مدمجة مثل "تسميع ...": type = "merged_review"، وضع النص في mergedText.
11. حافظ على الأرقام العربية (٠١٢٣٤٥٦٧٨٩) والنقطتين الرأسية في الآيات (مثل ١ : ١٢ الحاقة)، وإذا كانت الخلية فارغة أو بها شرطة فقط ضع "" للخلية الفارغة.`;

const SCHEDULE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: 'العنوان الرئيسي أعلى الجدول' },
    monthKey: { type: Type.STRING, description: 'السنة والشهر الهجري بصيغة YYYY-MM أو ""' },
    footerText: { type: Type.STRING, description: 'النص أسفل الجدول مثل اسم المجموعة' },
    colListenLabel: { type: Type.STRING, description: 'عنوان العمود الثالث من اليمين (الاستماع)' },
    colHifzLabel: { type: Type.STRING, description: 'عنوان العمود الرابع من اليمين (الحفظ)' },
    extraEnabled: { type: Type.BOOLEAN, description: 'true فقط إذا كان هناك عمود سابع إضافي بين الحفظ والمراجعة' },
    extraLabel: { type: Type.STRING, description: 'عنوان العمود الإضافي إن وجد وإلا ""' },
    colReviewLabel: { type: Type.STRING, description: 'عنوان عمود المراجعة (قبل الأخير يساراً)' },
    colFreeLabel: { type: Type.STRING, description: 'عنوان العمود الأخير أقصى اليسار (قراءة ما تيسر)' },
    rows: {
      type: Type.ARRAY,
      description: 'جميع صفوف الأيام بالترتيب من أعلى إلى أسفل',
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, description: 'normal أو friday أو exam أو merged_review' },
          dayName: { type: Type.STRING, description: 'اسم اليوم من العمود الأول يميناً' },
          hijriText: { type: Type.STRING, description: 'التاريخ الهجري من العمود الثاني يميناً مكتملاً باسم الشهر' },
          listenText: { type: Type.STRING, description: 'محتوى العمود الثالث (الاستماع)، أو "" إذا كان فارغاً أو مدمجاً' },
          hifzText: { type: Type.STRING, description: 'محتوى العمود الرابع (الحفظ مثل ١ : ٤٤ المعارج + نوح)، أو "" إذا كان فارغاً أو مدمجاً' },
          extraText: { type: Type.STRING, description: 'محتوى العمود الإضافي إن وجد (٧ أعمدة)، وإلا ""' },
          reviewText: { type: Type.STRING, description: 'محتوى عمود المراجعة (قبل الأخير يساراً مثل الحزب ٦٠)، أو "" إذا كان فارغاً أو مدمجاً' },
          freeText: { type: Type.STRING, description: 'محتوى عمود قراءة ما تيسر (أقصى اليسار)، وإلا ""' },
          mergedText: { type: Type.STRING, description: 'النص المدمج لصفوف friday أو exam أو merged_review، وإلا ""' },
        },
        required: [
          'type',
          'dayName',
          'hijriText',
          'listenText',
          'hifzText',
          'extraText',
          'reviewText',
          'freeText',
          'mergedText',
        ],
      },
    },
  },
  required: [
    'title',
    'monthKey',
    'footerText',
    'colListenLabel',
    'colHifzLabel',
    'extraEnabled',
    'extraLabel',
    'colReviewLabel',
    'colFreeLabel',
    'rows',
  ],
};

type ApiReq = IncomingMessage & { method?: string; body?: unknown };
type ApiRes = ServerResponse & {
  status?: (code: number) => ApiRes;
  json?: (data: unknown) => void;
};

function sendJson(res: ApiRes, statusCode: number, payload: unknown) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    const target = res.status(statusCode);
    if (target && typeof target.json === 'function') {
      target.json(payload);
      return;
    }
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: ApiReq): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') {
    return req.body as Record<string, unknown>;
  }
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default async function handler(req: ApiReq, res: ApiRes) {
  if (req.method && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';

    if (!imageBase64) {
      sendJson(res, 400, { error: 'يرجى إرسال صورة الجدول أولاً' });
      return;
    }

    const ai = getGeminiClient();
    if (!ai) {
      sendJson(res, 503, {
        error: 'مفتاح GEMINI_API_KEY غير مضبوط على الخادم لقراءة صورة الجدول',
      });
      return;
    }

    const cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '').trim();
    const safeMime = mimeType.startsWith('image/') ? mimeType : 'image/png';

    const modelsToTry = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
      const modelName = modelsToTry[attempt];
      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model: modelName,
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: safeMime,
                    data: cleanBase64,
                  },
                },
                { text: SCHEDULE_PROMPT },
              ],
            },
            config: {
              responseMimeType: 'application/json',
              responseSchema: SCHEDULE_RESPONSE_SCHEMA,
              ...(modelName === 'gemini-4-hydrogen'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
            },
          }),
          25000,
          modelName
        );

        const rawJson = (response.text ?? '{}').trim();
        const parsed = JSON.parse(rawJson) as ParsedSchedule;
        if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) {
          sendJson(res, 422, {
            error: 'لم يتم التعرف على صفوف واضحة في صورة الجدول، تأكدي من وضوح الصورة',
          });
          return;
        }
        sendJson(res, 200, { schedule: normalizeParsedSchedule(parsed), modelUsed: modelName });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < modelsToTry.length - 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }

    const rawErrMsg = lastErr instanceof Error ? lastErr.message : String(lastErr || '');
    console.error('parse-schedule error:', lastErr);
    if (/503|UNAVAILABLE|high demand|overloaded/i.test(rawErrMsg)) {
      sendJson(res, 503, {
        error: 'خادم الذكاء الاصطناعي يشهد ضغطاً مؤقتاً حالياً (503). يرجى المحاولة بعد قليل أو استخدام خيار «لصق نص / إكسل».',
      });
      return;
    }
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(rawErrMsg)) {
      sendJson(res, 429, {
        error: 'تم تجاوز الحد المسموح مؤقتاً لطلبات القراءة الذكية (429). يرجى المحاولة بعد قليل أو استخدام خيار «لصق نص / إكسل».',
      });
      return;
    }
    if (/403|PERMISSION_DENIED|API_KEY_INVALID/i.test(rawErrMsg)) {
      sendJson(res, 403, {
        error: 'مفتاح GEMINI_API_KEY غير صالح أو غير مفعّل. يمكنك استخدام خيار «لصق نص / إكسل».',
      });
      return;
    }
    sendJson(res, 500, { error: rawErrMsg || 'تعذر تحليل صورة الجدول' });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'حدث خطأ غير متوقع';
    console.error('parse-schedule unexpected error:', err);
    sendJson(res, 500, { error: errMsg });
  }
}
