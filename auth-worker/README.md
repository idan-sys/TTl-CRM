# אימות כניסה בדוא״ל

הסיסמה נבדקת ב-Firebase. אחרי בדיקת הסיסמה, Cloudflare Worker יוצר קוד חד-פעמי ושומר ב-Durable Object רק HMAC שלו. Google Apps Script שולח את המייל; הקוד עצמו נבדק ב-Worker ולא בדפדפן.

התמונה שקיבלנו תואמת למנגנון הישן: קוד נשלח דרך Google Apps Script, בעוד Firebase שימש לבדיקת הסיסמה. בקוד הישן הקוד נוצר ונבדק בדפדפן ולכן אפשר היה לעקוף את הבדיקה. המנגנון החדש אינו משתמש בקוד או בבדיקה בצד הדפדפן.

## יצירת שולח מייל מאובטח ב-Google Apps Script

כדי לא לשנות או לשבור את הפרויקט הישן, יש ליצור פרויקט Apps Script נפרד באותו חשבון Google ששולח כיום את המייל:

1. פותחים `script.google.com` עם חשבון הדוא״ל שממנו רוצים לשלוח את ההודעות ויוצרים פרויקט חדש.
2. מחליפים את התוכן של `Code.gs` בקוד המקומי שב-[Code.gs](./apps-script/Code.gs).
3. בהגדרות הפרויקט פותחים **Script Properties** ומוסיפים את `WORKER_SHARED_SECRET` עם מחרוזת אקראית סודית באורך 32 תווים לפחות. אין להכניס אותה לקובץ או לצ׳אט.
4. בוחרים **Deploy → New deployment → Web app**, מגדירים **Execute as: Me** ו-**Who has access: Anyone**, מאשרים את הרשאת השליחה, ומעתיקים את כתובת ה-Web App.
5. כתובת ה-Web App אינה סיסמה; מכניסים אותה למשתנה `GOOGLE_APPS_SCRIPT_URL` ב-`auth-worker/wrangler.jsonc`. הסוד `WORKER_SHARED_SECRET` צריך להיות זהה גם כ-Cloudflare Worker Secret.

הגישה הציבורית ל-Web App נדרשת כדי שה-Worker יוכל לקרוא לו ללא התחברות Google. הוא לא שולח מייל בלי הסוד המשותף, שאינו נמצא באתר או בדפדפן. Apps Script שולח מחשבון Google שביצע את הפריסה; מגבלות השליחה היומיות של Google עדיין חלות.

אין צורך בחשבון Resend או בשינוי DNS כדי לשלוח קודים בדרך זו. לאחר שהמערכת החדשה נבדקה ועובדת, אפשר להשבית את הפריסה הישנה של Apps Script — לא לפני כן, כדי לא לנתק מערכת שעדיין משתמשת בה.

## הכנה ופריסה של ה-Worker

מתוך תיקיית `auth-worker`:

```powershell
npm.cmd install
npm.cmd test
```

כתובת האתר המדויקת כבר הוגדרה ב-`APP_ORIGIN` שב-`wrangler.jsonc`:
`https://talthelife-crm.idan-talthelife.workers.dev`

האימות מול Google משתמש ב-Workload Identity Federation ובחתימה מרחוק דרך Google IAM. אין ליצור או להוריד מפתח פרטי של חשבון שירות Google. ה-Worker מפרסם את מסמך ה-OIDC ואת ה-JWKS הציבורי בכתובות:

- `https://ttl-crm-email-mfa.idan-talthelife.workers.dev/.well-known/openid-configuration`
- `https://ttl-crm-email-mfa.idan-talthelife.workers.dev/.well-known/jwks.json`

### מפתח החתימה של ה-Worker

לאחר פריסת קוד ה-Worker המעודכן, מתוך `auth-worker` מריצים:

```powershell
node scripts/setup-wif-key.mjs
```

הסקריפט יוצר מפתח OIDC ייעודי במחשב, מעלה אותו כ-Cloudflare Secret בשם `WIF_SIGNING_PRIVATE_KEY`, ומוחק את קובץ הביניים. המפתח אינו מפתח של Google ואינו נשמר במאגר הקוד. אין להריץ את הסקריפט שוב אלא בעת החלפת מפתח מתוכננת.

### הגדרת Google Cloud

בפרויקט Firebase/Google Cloud `tal-the-life-crm2`:

1. מפעילים את ממשקי `Security Token Service API`, `IAM Service Account Credentials API` ו-`Cloud Firestore API`.
2. יוצרים Workload Identity Pool בשם `ttl-crm-mfa` וספק OIDC בשם `cloudflare-worker`.
3. מגדירים את כתובת המנפיק בדיוק כך: `https://ttl-crm-email-mfa.idan-talthelife.workers.dev`. Google יקרא את מסמך ה-OIDC ואת ה-JWKS מהכתובות שלמעלה.
4. משאירים את `Default audience` מסומן. במיפוי המאפיינים מגדירים `google.subject=assertion.sub`. ה-Worker כבר מוגדר להשתמש ב-audience שמוצג כברירת מחדל ובמשאב הספק:
   - audience לאסימון OIDC: `https://iam.googleapis.com/projects/1044877642229/locations/global/workloadIdentityPools/ttl-crm-mfa/providers/cloudflare-worker`
   - מזהה משאב עבור Token Exchange: `//iam.googleapis.com/projects/1044877642229/locations/global/workloadIdentityPools/ttl-crm-mfa/providers/cloudflare-worker`
5. יוצרים חשבון שירות ייעודי בשם `ttl-crm-mfa-signer` באותו פרויקט. לא יוצרים לו מפתח.
6. לחשבון השירות החיצוני מה-Pool מעניקים `Service Account Token Creator` על חשבון השירות הייעודי, כדי לאפשר חתימה מרחוק על Firebase Custom Tokens.
7. אין להעניק ל-Worker הרשאות IAM למסד הנתונים. הוא משתמש באסימון Firebase של המשתמש כדי לקרוא רק את מסמך המשתמש שלו, לפי כללי Firestore.
8. כתובת הדוא״ל של חשבון השירות הייעודי מוגדרת ב-`FIREBASE_SERVICE_ACCOUNT_EMAIL` בתוך `wrangler.jsonc`.

המזהה החיצוני של ה-Worker ב-Workload Identity Pool הוא:
`principal://iam.googleapis.com/projects/1044877642229/locations/global/workloadIdentityPools/ttl-crm-mfa/subject/ttl-crm-email-mfa`

יש להגדיר ב-Cloudflare את הערכים הבאים כ-Secrets:

- `WIF_SIGNING_PRIVATE_KEY` — נוצר ומועלה על ידי הסקריפט לעיל.
- `GOOGLE_APPS_SCRIPT_SHARED_SECRET`
- `OTP_HASH_SECRET` — מפתח אקראי המשמש ל-HMAC של קוד האימות.

`WIF_ISSUER`, `WIF_AUDIENCE`, `WIF_PROVIDER_RESOURCE` ו-`WIF_SIGNING_KEY_ID` כבר מוגדרים ב-`wrangler.jsonc`. כתובת חשבון השירות אינה סוד. אין להוסיף פרטי גישה לקובץ התצורה או למאגר Git.

לבדיקה מקומית בלבד, יוצרים `auth-worker/.dev.vars` עם שלושת ערכי ה-Secrets (ללא מרכאות). הקובץ מוחרג מ-Git; אין לשתף או להעלות אותו.

לאחר השלמת הגדרות Google ו-Cloudflare יש להריץ `npm.cmd run deploy`, לבדוק ש-`GET /health` מחזיר `200`, ואז לבדוק שליחת קוד וכניסה מלאה. פריסת ה-Worker אינה מפרסמת את כללי Firestore או את קובצי האתר.

הקובץ `firestore.indexes.json` מכיל את האינדקסים הדרושים לשאילתות העובדים לפי משתמש, סטטוס ותת-פרויקט. אפשר ליצור אותם מראש ב-Firebase Console; יצירת אינדקסים אינה מפעילה את כללי האבטחה.

## השלמת החיבור לאתר

כתובת ה-Worker הצפויה היא `https://ttl-crm-email-mfa.idan-talthelife.workers.dev`. אחרי פריסת ה-Worker, יש להכניס את כתובתו ל-`apiBaseUrl` שב-[auth-config.js](../auth-config.js), ולהעלות יחד את [index.html](../index.html), [auth-config.js](../auth-config.js) ו-[brand-logo.png](../brand-logo.png) לאתר. יש לבדוק כניסת מנהל ועובד עם קוד תוך שימוש בכללי Firestore הקיימים; לאחר שהבדיקה עוברת, מפרסמים את [firestore.rules](../firestore.rules) כדי לדרוש MFA בגישה לנתוני המערכת. הכללים מאפשרים קריאה למסמך המשתמש של עצמו גם עם אסימון סיסמה לצורך פתיחת האתגר וגם אחרי MFA; הם אינם מאפשרים לעובדים לקרוא רשימת משתמשים או לשנות מסמכי משתמש. רשומות לקוח מנוהלות באוסף `projects`; אוסף `clients` הישן אינו בשימוש באפליקציה ואינו מורשה לכל משתמש.

## הוספת עובד

1. ב-Firebase Console פותחים את **Authentication → Users** ויוצרים חשבון עם כתובת הדוא״ל של העובד וסיסמה זמנית.
2. מעתיקים את ה-UID של החשבון.
3. בלוח הבקרה של ה-CRM ממלאים שם, דוא״ל, UID ותפקיד ושומרים את הפרופיל.
4. העובד נכנס עם הדוא״ל/שם המשתמש והסיסמה הזמנית; לאחר אימות הסיסמה יישלח אליו קוד כניסה למייל.

הסרת פרופיל משתמש מבטלת את הגישה ל-CRM, אך אינה מוחקת את חשבון Firebase Authentication. אין לשמור סיסמאות או מפתחות בקובצי ה-CRM.

הרשאות עובדים: `Staff_All` יכול לקרוא את כל התיקים הפעילים מכל סוג; `Staff_Egg` יכול לקרוא את כל תיקי תרומת הביצית; `Staff_Sur` יכול לקרוא את כל תיקי הפונדקאות, כולל פונדקאות + תרומת ביצית. מנהלי מערכת יכולים לקרוא את סל המחזור. עובדי תחום יכולים לערוך רק תיקים המשויכים אליהם, ואילו `Staff_All` יכול לערוך את כל התיקים הפעילים. מנהל יכול לשנות תפקיד והרשאת צפייה בהסכמים חתומים בטבלת ניהול המשתמשים. אדמינים תמיד מורשים להסכמים. פרופיל עם תפקיד ישן או לא מוכר, כגון `Staff`, יידחה בכניסה; יש לבחור ולשמור עבורו תפקיד תקין. רק מנהל יכול לשנות הגדרות, רשימות, אנשי קשר ופרופילי משתמשים.

קישורי הסכמים חתומים מאוחסנים ב-`project_agreements`, בנפרד ממסמכי הפרויקטים. לעובד נדרשת `can_view_agreements: true` בפרופיל המשתמש, בנוסף להרשאת הצפייה בתיק עצמו. משתמשים קיימים וחדשים מתחילים ללא הרשאת הסכמים; מנהל מסמן את העובדים המורשים בטבלת ניהול המשתמשים. לאחר פרסום הקוד, כללי Firestore והאינדקסים החדשים, מנהל צריך להפעיל פעם אחת את העברת קישורי ההסכמים מתוך מסך ניהול המשתמשים. עד שתיק סומן `agreement_links_migrated: true`, הוא לא יוצג לעובדים; המנהל ממשיך לראות את כל התיקים. אין לפרסם את כללי Firestore החדשים לפני בדיקת גיבוי ויכולת כניסת מנהל.

רשימת התיקים נפתחת כברירת מחדל במיון א׳–ב׳, וניתן לשנות את המיון מתוך המסך. בכרטיסי פונדקאות, מנהל יכול לשנות את הסיווג בין פונדקאות לבין פונדקאות + תרומת ביצית; שינוי `project_type` מעביר את התיק אוטומטית למסנן ולמונה המתאימים. יצירת תיק ב-CRM אינה יוצרת תיקייה ב-Google Drive, ויצירת תיקייה ב-Drive אינה יוצרת רשומת CRM. יש להעתיק ידנית את קישור תיקיית ה-Drive לשדה הקישור בכרטיס הלקוח.
