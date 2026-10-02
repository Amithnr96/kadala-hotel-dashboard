import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const scrypt = promisify(scryptCallback);
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const equal = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const fields = ['upi','cash','staff','rent','egg','fish','chicken','water','gas','vegetables','cooldrinks','chapati','dairy','misc','extra','leaf'];
const problem = (status, message) => Object.assign(new Error(message), { status });

export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw problem(400, 'Use a password of 12–128 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password, hash) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, key] = hash.split(':');
  const actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
function username(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,49}$/.test(value)) throw problem(400, 'Use a username of 3–50 letters, numbers, dots, underscores or hyphens.');
  return value.toLowerCase();
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function cleanRecord(date, input) {
  if (!validDate(date) || !input || typeof input !== 'object' || Array.isArray(input)) throw problem(400, 'Invalid daily record.');
  const result = { date };
  const amount = value => {
    if (value === undefined || value === '') return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) throw problem(400, 'Amounts must be non-negative numbers with at most two decimal places.');
    return value;
  };
  for (const key of fields) result[key] = amount(input[key]);
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 2000)) throw problem(400, 'Notes must be at most 2,000 characters.');
  result.notes = input.notes || '';
  if (input.customExpenses !== undefined && (!Array.isArray(input.customExpenses) || input.customExpenses.length > 100)) throw problem(400, 'Use at most 100 custom expenses per day.');
  result.customExpenses = (input.customExpenses || []).map(item => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 100) throw problem(400, 'Each custom expense needs a name of up to 100 characters.');
    return { name: item.name.trim(), amount: amount(item.amount) };
  });
  return result;
}

export async function initialize(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS hotel_users (
      id text PRIMARY KEY, username text UNIQUE NOT NULL, role text NOT NULL CHECK(role IN ('owner','staff')),
      password_hash text, active boolean NOT NULL DEFAULT true, invitation_hash text UNIQUE,
      invitation_expires timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_hotel_owner ON hotel_users(role) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS hotel_sessions (
      token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES hotel_users(id) ON DELETE CASCADE,
      csrf text NOT NULL, expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hotel_records (
      day text PRIMARY KEY, data jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
      updated_by text REFERENCES hotel_users(id), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS hotel_rate_limits (key text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL);
    ALTER TABLE hotel_users DROP CONSTRAINT IF EXISTS hotel_users_role_check;
    ALTER TABLE hotel_users ADD CONSTRAINT hotel_users_role_check CHECK(role IN ('owner','staff','inventory'));
    CREATE TABLE IF NOT EXISTS hotel_inventory (
      day text PRIMARY KEY, data jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
      updated_by text REFERENCES hotel_users(id), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export function cleanInventory(day, input) {
  if (!validDate(day) || !input || typeof input!=='object' || !Array.isArray(input.meat) || !Array.isArray(input.custom) || input.meat.length!==3 || input.custom.length>100) throw problem(400,'Invalid inventory record.');
  const quantity=value=>{if(value===null||value==='')return null;if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000000000||Math.abs(value*1000-Math.round(value*1000))>0.0001)throw problem(400,'Stock must be a non-negative number with up to three decimal places.');return value;};
  const item=row=>{if(!row||typeof row.name!=='string'||!row.name.trim()||row.name.trim().length>100||!['kg','g','litres','ml','pieces'].includes(row.unit))throw problem(400,'Enter an item name and a valid unit.');return {name:row.name.trim(),unit:row.unit,opening:quantity(row.opening),closing:quantity(row.closing)};};
  const meat=input.meat.map(item), custom=input.custom.map(item);
  if(meat.map(row=>row.name).join(',')!=='Chicken,Fish,Egg')throw problem(400,'Meat items must be Chicken, Fish and Egg.');
  if(new Set(custom.map(row=>row.name.toLowerCase())).size!==custom.length)throw problem(400,'Use a different name for each custom item.');
  const fishNames=["Prawns Portions","Crab","Bhangde","Mathi","Pomfret","Anjal","Kane"];
  const fishInput=input.fish===undefined?fishNames.map(name=>({name,unit:'kg',opening:null,closing:null})):input.fish;
  const customFishInput=input.customFish===undefined?[]:input.customFish;
  if(!Array.isArray(fishInput)||fishInput.length!==fishNames.length||!Array.isArray(customFishInput)||customFishInput.length>100)throw problem(400,'Invalid fish inventory.');
  const fish=fishInput.map(item),customFish=customFishInput.map(item);
  if(fish.some((row,i)=>row.name!==fishNames[i]))throw problem(400,'Use the listed fish varieties.');
  const allFish=[...fish,...customFish].map(row=>row.name.toLowerCase());
  if(new Set(allFish).size!==allFish.length)throw problem(400,'Use a different name for each custom fish.');
  return {date:day,meat,custom,fish,customFish};
}

export async function createApp({ db, origin, setupToken, secure = true }) {
  if (!origin || new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an exact origin without a trailing slash.');
  await initialize(db);
  const dummyHash = await passwordHash(token());
  const root = new URL('./', import.meta.url);
  const cookieName = secure ? '__Host-kadala_session' : 'kadala_session';
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  async function transaction(fn) {
    const connection = await db.connect();
    try { await connection.query('BEGIN'); const result = await fn(connection); await connection.query('COMMIT'); return result; }
    catch (err) { await connection.query('ROLLBACK'); throw err; }
    finally { connection.release(); }
  }
  async function throttle(key, limit = 10) {
    const result = await db.query(`INSERT INTO hotel_rate_limits(key, attempts, expires_at) VALUES ($1,1,now()+interval '15 minutes')
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN hotel_rate_limits.expires_at<now() THEN 1 ELSE hotel_rate_limits.attempts+1 END,
      expires_at=CASE WHEN hotel_rate_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE hotel_rate_limits.expires_at END RETURNING attempts`, [digest(key)]);
    if (result.rows[0].attempts > limit) throw problem(429, 'Too many attempts. Please try again in 15 minutes.');
  }
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw problem(415, 'JSON required.');
    let data = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw problem(413, 'Upload is too large.'); data += chunk; }
    try { return JSON.parse(data); } catch { throw problem(400, 'Invalid JSON.'); }
  }
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  async function session(req) {
    const raw = String(req.headers.cookie || '').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!raw || !/^[a-zA-Z0-9_-]{43}$/.test(raw)) return null;
    const result = await db.query(`SELECT u.id,u.username,u.role,s.csrf,s.token_hash FROM hotel_sessions s JOIN hotel_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`, [digest(raw)]);
    return result.rows[0] || null;
  }
  async function startSession(res, user) {
    const raw = token();
    await db.query('DELETE FROM hotel_sessions WHERE expires_at<now()');
    await db.query(`INSERT INTO hotel_sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')`, [digest(raw),user.id,token()]);
    res.setHeader('Set-Cookie', cookie(raw, 43200));
  }
  async function file(res, name, type) { const content = await readFile(new URL(name, root));res.writeHead(200, { 'Content-Type': type });res.end(content); }
  function owner(user) { if (user.role !== 'owner') throw problem(403, 'Only the owner can do this.'); }
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && path === '/healthz') return json(res,200,{ok:true});
      if (req.method === 'GET' && ['/login','/setup','/activate'].includes(path)) return file(res,'auth.html','text/html; charset=utf-8');
      if (req.method === 'GET' && path === '/auth.js') return file(res,'auth.js','application/javascript; charset=utf-8');
      if (!['GET','HEAD'].includes(req.method) && req.headers.origin !== origin) throw problem(403,'Request origin not allowed.');
      if (req.method === 'POST' && ['/api/login','/api/setup','/api/activate'].includes(path)) {
        const data = await body(req);
        await throttle(`auth-ip:${req.socket.remoteAddress}`, 100);
        if (path === '/api/login') {
          const name = username(data.username);await throttle(`login:${name}`);
          const user = (await db.query('SELECT * FROM hotel_users WHERE username=$1',[name])).rows[0];
          const matches = await passwordMatches(data.password,user?.password_hash || dummyHash);
          if (!matches || !user?.active || !user.password_hash) throw problem(401,'Incorrect username or password.');
          await startSession(res,user);return json(res,200,{ok:true});
        }
        if (path === '/api/setup') {
          await throttle('setup');
          if (!setupToken || setupToken.length < 32 || typeof data.token !== 'string' || !equal(data.token,setupToken)) throw problem(403,'Invalid setup token.');
          const name=username(data.username), hash=await passwordHash(data.password), id=token();
          await transaction(async tx => {
            await tx.query('LOCK TABLE hotel_users IN EXCLUSIVE MODE');
            if ((await tx.query("SELECT id FROM hotel_users WHERE role='owner'")).rows.length) throw problem(409,'The owner account is already set up.');
            await tx.query("INSERT INTO hotel_users(id,username,role,password_hash) VALUES($1,$2,'owner',$3)",[id,name,hash]);
          });
          await startSession(res,{id});return json(res,201,{ok:true});
        }
        await throttle('activation');
        if (typeof data.token !== 'string' || data.token.length > 100) throw problem(400,'Invalid invitation.');
        const hash=await passwordHash(data.password);
        const result=await db.query('UPDATE hotel_users SET password_hash=$1,invitation_hash=NULL,invitation_expires=NULL WHERE invitation_hash=$2 AND invitation_expires>now() AND active=true RETURNING id',[hash,digest(data.token)]);
        if (!result.rows.length) throw problem(400,'Invitation is invalid or expired. Ask the owner for a new one.');
        await db.query('DELETE FROM hotel_sessions WHERE user_id=$1',[result.rows[0].id]);
        await startSession(res,result.rows[0]);return json(res,200,{ok:true});
      }
      const user=await session(req);
      if (!user) {
        if (req.method==='GET' && !path.startsWith('/api/')) {res.writeHead(303,{Location:'/login'});return res.end();}
        throw problem(401,'Please sign in.');
      }
      if (!['GET','HEAD'].includes(req.method) && !equal(req.headers['x-csrf-token']||'',user.csrf)) throw problem(403,'Session verification failed. Reload and try again.');
      if (user.role==='inventory' && !['/','/inventory','/inventory.js','/api/session','/api/logout','/api/password'].includes(path) && !/^\/api\/inventory\/[^/]+$/.test(path)) throw problem(403,'This account has access to inventory only.');
      if (req.method==='GET' && path==='/') return file(res,user.role==='inventory'?'inventory.html':'shared.html','text/html; charset=utf-8');
      if (req.method==='GET' && path==='/inventory') return file(res,'inventory.html','text/html; charset=utf-8');
      if (req.method==='GET' && path==='/inventory.js') return file(res,'inventory.js','application/javascript; charset=utf-8');
      if (path.startsWith('/api/inventory/')) {
        const day=path.slice('/api/inventory/'.length);if(!validDate(day))throw problem(400,'Choose a valid inventory date.');
        if(req.method==='GET'){const row=(await db.query('SELECT data,revision FROM hotel_inventory WHERE day=$1',[day])).rows[0];return json(res,200,row?{record:row.data,revision:row.revision}:{record:null,revision:0});}
        if(req.method==='PUT'){
          const data=await body(req);
          if(data.record && (data.record.fish===undefined || data.record.customFish===undefined)) {
            const previous=(await db.query('SELECT data FROM hotel_inventory WHERE day=$1',[day])).rows[0]?.data;
            if(previous){if(data.record.fish===undefined)data.record.fish=previous.fish;if(data.record.customFish===undefined)data.record.customFish=previous.customFish;}
          }
          const record=cleanInventory(day,data.record);if(!Number.isSafeInteger(data.revision)||data.revision<0)throw problem(400,'Invalid inventory revision.');
          const result=data.revision===0?await db.query('INSERT INTO hotel_inventory(day,data,updated_by) VALUES($1,$2,$3) ON CONFLICT(day) DO NOTHING RETURNING revision',[day,JSON.stringify(record),user.id]):await db.query('UPDATE hotel_inventory SET data=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE day=$3 AND revision=$4 RETURNING revision',[JSON.stringify(record),user.id,day,data.revision]);
          if(!result.rows.length)throw problem(409,'Someone else updated this inventory date. Download your unsaved copy, then reload before editing again.');
          return json(res,200,{revision:result.rows[0].revision});
        }
      }
      if (req.method==='GET' && path==='/dashboard.js') return file(res,'dashboard.js','application/javascript; charset=utf-8');
      if (req.method==='GET' && path==='/accounts') {owner(user);return file(res,'accounts.html','text/html; charset=utf-8');}
      if (req.method==='GET' && path==='/accounts.js') {owner(user);return file(res,'accounts.js','application/javascript; charset=utf-8');}
      if (req.method==='GET' && path==='/api/session') return json(res,200,{username:user.username,role:user.role,csrf:user.csrf});
      if (req.method==='POST' && path==='/api/logout') {await db.query('DELETE FROM hotel_sessions WHERE token_hash=$1',[user.token_hash]);res.setHeader('Set-Cookie',cookie('',0));return json(res,200,{ok:true});}
      if (req.method==='POST' && path==='/api/password') {
        await throttle(`password:${user.id}`);
        const data=await body(req), current=(await db.query('SELECT password_hash FROM hotel_users WHERE id=$1',[user.id])).rows[0];
        if (!await passwordMatches(data.currentPassword,current.password_hash)) throw problem(400,'Current password is incorrect.');
        const hash=await passwordHash(data.password);
        await transaction(async tx=>{await tx.query('UPDATE hotel_users SET password_hash=$1 WHERE id=$2',[hash,user.id]);await tx.query('DELETE FROM hotel_sessions WHERE user_id=$1',[user.id]);});
        await startSession(res,user);return json(res,200,{ok:true});
      }
      if (req.method==='GET' && path==='/api/records') {
        const rows=(await db.query('SELECT day,data,revision,updated_at FROM hotel_records ORDER BY day')).rows;
        return json(res,200,{records:Object.fromEntries(rows.map(r=>[r.day,{...r.data,_revision:r.revision}]))});
      }
      if (req.method==='PUT' && path.startsWith('/api/records/')) {
        const day=path.slice('/api/records/'.length), data=await body(req), record=cleanRecord(day,data.record);
        if (!Number.isSafeInteger(data.revision)||data.revision<0) throw problem(400,'Invalid record revision.');
        let result;
        if (data.revision===0) result=await db.query('INSERT INTO hotel_records(day,data,updated_by) VALUES($1,$2,$3) ON CONFLICT(day) DO NOTHING RETURNING revision',[day,JSON.stringify(record),user.id]);
        else result=await db.query('UPDATE hotel_records SET data=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE day=$3 AND revision=$4 RETURNING revision',[JSON.stringify(record),user.id,day,data.revision]);
        if (!result.rows.length) throw problem(409,'Someone else changed this day. Your changes have not been saved. Reload the latest record before editing again.');
        return json(res,200,{revision:result.rows[0].revision});
      }
      if (req.method==='POST' && path==='/api/import') {
        owner(user);const data=await body(req);
        if (!data.records || typeof data.records!=='object' || Array.isArray(data.records) || Object.keys(data.records).length>5000) throw problem(400,'Invalid backup.');
        const records=Object.entries(data.records).map(([day,row])=>[day,cleanRecord(day,row)]);
        let imported=0;
        await transaction(async tx=>{for(const [day,row] of records){const result=await tx.query('INSERT INTO hotel_records(day,data,updated_by) VALUES($1,$2,$3) ON CONFLICT(day) DO NOTHING RETURNING day',[day,JSON.stringify(row),user.id]);imported+=result.rows.length;}});
        return json(res,200,{imported,skipped:records.length-imported});
      }
      if (path==='/api/users' && req.method==='GET') {owner(user);return json(res,200,{users:(await db.query('SELECT id,username,role,active,(password_hash IS NOT NULL) AS activated FROM hotel_users ORDER BY created_at')).rows});}
      if (path==='/api/users' && req.method==='POST') {
        owner(user);const data=await body(req), name=username(data.username), invitation=token();
        const role=data.role||'staff';if(!['staff','inventory'].includes(role))throw problem(400,'Choose Staff or Inventory only.');
        if ((await db.query("SELECT id FROM hotel_users WHERE role<>'owner'")).rows.length>=50) throw problem(400,'Staff account limit reached.');
        await db.query("INSERT INTO hotel_users(id,username,role,invitation_hash,invitation_expires) VALUES($1,$2,$3,$4,now()+interval '24 hours')",[token(),name,role,digest(invitation)]);
        return json(res,201,{url:`${origin}/activate#${invitation}`});
      }
      if (path.startsWith('/api/users/') && req.method==='POST') {
        owner(user);const id=path.slice('/api/users/'.length),data=await body(req);
        if (!['disable','invite','role'].includes(data.action)) throw problem(400,'Invalid account action.');
        if(data.action==='role'&&!['staff','inventory'].includes(data.role))throw problem(400,'Choose Staff or Inventory only.');
        const invitation=token();
        await transaction(async tx=>{
          const result=await tx.query("SELECT id FROM hotel_users WHERE id=$1 AND role<>'owner' FOR UPDATE",[id]);if(!result.rows.length)throw problem(404,'Staff account not found.');
          await tx.query('DELETE FROM hotel_sessions WHERE user_id=$1',[id]);
          if(data.action==='role')await tx.query('UPDATE hotel_users SET role=$1 WHERE id=$2',[data.role,id]);
          else if(data.action==='disable')await tx.query('UPDATE hotel_users SET active=false,invitation_hash=NULL,invitation_expires=NULL WHERE id=$1',[id]);
          else await tx.query("UPDATE hotel_users SET active=true,password_hash=NULL,invitation_hash=$1,invitation_expires=now()+interval '24 hours' WHERE id=$2",[digest(invitation),id]);
        });
        return json(res,200,data.action==='invite'?{url:`${origin}/activate#${invitation}`}:{ok:true});
      }
      throw problem(404,'Not found.');
    } catch(err) {
      if(err.code==='23505')return json(res,409,{error:'That username already exists.'});
      if(!err.status)console.error('Request failed:',err.code||err.name);
      json(res,err.status||500,{error:err.status?err.message:'Unable to complete the request. Please try again.'});
    }
  });
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL || !process.env.APP_ORIGIN) throw new Error('DATABASE_URL and APP_ORIGIN are required.');
  const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
  const app=await createApp({db,origin:process.env.APP_ORIGIN,setupToken:process.env.SETUP_TOKEN,secure:process.env.NODE_ENV!=='development'});
  app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Kadala server ready'));
  process.on('SIGTERM',()=>app.close(async()=>{await db.end();process.exit(0)}));
}
