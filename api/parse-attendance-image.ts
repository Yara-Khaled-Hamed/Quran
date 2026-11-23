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

const ATTENDANCE_OCR_PROMPT = `أنت مساعد خبير في قراءة أسماء الأعضاء/الطالبات من صور لقطات شاشة الواتساب (سواء استطلاعات الرأي، أو رسائل غياب الاستماع/التسميع، أو قوائم المجموعات).
استخرج جميع أسماء الأشخاص الظاهرة في الصورة بدقة تامة من الأعلى إلى الأسفل بدون تجاهل أي اسم!

قواعد الاستخراج الإلزامية:
1. استخرج كل اسم يظهر في القائمة سواء كان اسماً مركباً (مثل: نسمة محمد) أو اسماً من كلمة واحدة قصيرة (مثل: نسمة، ندى، هبة، منى، سارة، آية).
2. إذا ظهر رقم هاتف ومعه اسم بعد علامة ~ (مثل: +20 100... ~ نسمة)، استخرج الاسم فقط ("نسمة").
3. تجاهل تماماً:
   - عناوين الرسائل والاستطلاعات مثل: "تفاصيل الاستطلاع"، "استطلاع الرأي"، "المصوتون"، "غياب الإستماع ليوم..."، "غياب التسميع ليوم..."، "مثابرات الإسبوع"، "خيارات"، "أصوات".
   - الإيموجي والرموز مثل: 🥀، 🌹، 🔴، ✅، ❌، 👑، 🌻، 🍃.
   - كلمات التنبيه مثل: "إنذار بالحذف"، "تسميع فقط".
   - التواريخ والأوقات مثل: "أمس"، "اليوم"، "٨:١٥ م"، "منذ ٥ دقائق".
4. حافظ على كتابة الاسم كما هو بدون اختصار أو حذف أي اسم في أعلى أو أسفل الصورة.
5. هذه الصورة قد تكون قائمة طويلة أو جزءاً من لقطة شاشة مطولة: اقرأ واستخرج كل اسم ظاهر من أول سطر في الأعلى حتى آخر سطر في الأسفل بالكامل بدون تخطي أي اسم في المنتصف أو النهاية.`;

const ATTENDANCE_OCR_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    names: {
      type: Type.ARRAY,
      description: 'قائمة جميع أسماء الأشخاص المستخرجة من الصورة بالترتيب',
      items: { type: Type.STRING },
    },
  },
  required: ['names'],
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
      sendJson(res, 400, { error: 'يرجى إرسال صورة الأسماء أولاً' });
      return;
    }

    const ai = getGeminiClient();
    if (!ai) {
      sendJson(res, 503, {
        error: 'GEMINI_API_KEY غير مضبوط',
        fallback: true,
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
                { text: ATTENDANCE_OCR_PROMPT },
              ],
            },
            config: {
              responseMimeType: 'application/json',
              responseSchema: ATTENDANCE_OCR_SCHEMA,
              ...(modelName === 'gemini-4-hydrogen'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
            },
          }),
          25000,
          modelName
        );

        const rawJson = (response.text ?? '{}').trim();
        const parsed = JSON.parse(rawJson) as { names?: unknown };
        const names = Array.isArray(parsed?.names)
          ? parsed.names.map((n) => String(n || '').trim()).filter(Boolean)
          : [];
        sendJson(res, 200, { names, modelUsed: modelName });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < modelsToTry.length - 1) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }

    const rawErrMsg = lastErr instanceof Error ? lastErr.message : String(lastErr || '');
    console.error('parse-attendance-image error:', lastErr);
    sendJson(res, 503, { error: rawErrMsg || 'تعذر قراءة الصورة ذكياً', fallback: true });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'حدث خطأ غير متوقع';
    console.error('parse-attendance-image unexpected error:', err);
    sendJson(res, 500, { error: errMsg, fallback: true });
  }
}
