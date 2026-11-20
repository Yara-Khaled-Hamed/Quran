import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
4. لا تدمج نص عمودين معاً ولا تتخطَّ عمود الحفظ (hifzText) أو عمود المراجعة (reviewText) أبداً!
5. اقرأ جميع الأيام من اليوم الأول إلى آخر يوم دون حذف أي صف.
6. إذا ظهرت علامة التكرار // أو " في أي خلية (خصوصاً بخط اليد)، كرر نفس نص الخلية التي فوقها مباشرة في نفس العمود.
7. يوم الجمعة أو الصف المدمج الذي يحتوي "قراءة سورة الكهف": type = "friday"، وضع النص في mergedText.
8. الصف الأحمر أو الصف الذي فيه "إختبار" / "اختبار": type = "exam"، وضع النص كاملاً في mergedText.
9. الصف الذي فيه الاستماع في عموده وباقي الخلايا الوسطى مدمجة مثل "تسميع ...": type = "merged_review"، وضع النص في mergedText.
10. حافظ على الأرقام العربية (٠١٢٣٤٥٦٧٨٩) والنقطتين الرأسية في الآيات (مثل ١ : ١٢ الحاقة)، وإذا كانت الخلية فارغة أو بها شرطة فقط ضع "" للخلية الفارغة.`;

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
          hijriText: { type: Type.STRING, description: 'التاريخ الهجري من العمود الثاني يميناً' },
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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.post('/api/parse-schedule', async (req: Request, res: Response) => {
    try {
      const { imageBase64, mimeType } = (req.body || {}) as {
        imageBase64?: string;
        mimeType?: string;
      };
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        res.status(400).json({ error: 'يرجى إرسال صورة الجدول أولاً' });
        return;
      }

      const ai = getGeminiClient();
      if (!ai) {
        res.status(503).json({
          error: 'مفتاح GEMINI_API_KEY غير مضبوط على الخادم لقراءة صورة الجدول',
        });
        return;
      }

      const cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '').trim();
      const safeMime = typeof mimeType === 'string' && mimeType.startsWith('image/')
        ? mimeType
        : 'image/png';

      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
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
            },
          });

          const rawJson = (response.text ?? '{}').trim();
          const parsed = JSON.parse(rawJson);
          if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) {
            res.status(422).json({
              error: 'لم يتم التعرف على صفوف واضحة في صورة الجدول، تأكدي من وضوح الصورة',
            });
            return;
          }
          res.json({ schedule: parsed });
          return;
        } catch (err) {
          lastErr = err;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 700));
          }
        }
      }

      const errMsg = lastErr instanceof Error ? lastErr.message : 'تعذر تحليل صورة الجدول';
      console.error('parse-schedule error:', lastErr);
      res.status(500).json({ error: errMsg });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'حدث خطأ غير متوقع';
      console.error('parse-schedule unexpected error:', err);
      res.status(500).json({ error: errMsg });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });
}

startServer();
