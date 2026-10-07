import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { FIX_RELEASE_DAYS, PLAN_LIMITS } from "./limits.js";

export type Plan = keyof typeof PLAN_LIMITS;
export interface Account { id:string; email:string; passwordHash:string; salt:string; plan:Plan; createdAt:string; usage:{day:string; analyses:number; fixes:number}; billingCycleStartedAt?:string; fixCycleKey?:string; }
const dataFile=join(process.cwd(),"data","accounts.json");
const secret=process.env.METHIS_SESSION_SECRET || (process.env.NODE_ENV==="production" ? (()=>{ throw new Error("METHIS_SESSION_SECRET must be set in production."); })() : randomBytes(32).toString("hex"));

let accounts:Account[]|null=null;

async function load(){if(accounts)return accounts;try{accounts=JSON.parse(await readFile(dataFile,"utf8")) as Account[]}catch{accounts=[]}return accounts;}
async function save(){await mkdir(dirname(dataFile),{recursive:true});await writeFile(dataFile,JSON.stringify(accounts??[],null,2),"utf8");}
function normalizeEmail(email:string){return email.trim().toLowerCase();}
function hash(password:string,salt:string){return scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString("hex");}
function tokenFor(account:Account){const payload=Buffer.from(JSON.stringify({id:account.id,email:account.email,exp:Date.now()+7*86400000})).toString("base64url");const sig=createHmac("sha256",secret).update(payload).digest("base64url");return payload+"."+sig;}
function verifyToken(token:string){const [payload,sig]=token.split(".");if(!payload||!sig)return null;const expected=createHmac("sha256",secret).update(payload).digest("base64url");if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;try{const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));if(!data.id||data.exp<Date.now())return null;return data as {id:string;email:string;exp:number};}catch{return null;}}
function resetDailyUsage(account:Account){const day=new Date().toISOString().slice(0,10);if(account.usage.day!==day){account.usage.day=day;account.usage.analyses=0;}ensureFixCycle(account);}
function cycleStart(account:Account):Date{return account.plan==="pro"&&account.billingCycleStartedAt?new Date(account.billingCycleStartedAt):new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),1));}
function cycleKey(account:Account,now=new Date()):string{if(account.plan==="free")return now.toISOString().slice(0,7);return cycleStart(account).toISOString().slice(0,10);}
function ensureFixCycle(account:Account){const key=cycleKey(account);if(account.fixCycleKey!==key){account.fixCycleKey=key;account.usage.fixes=0;}}
function releasedFixes(account:Account,now=new Date()):number{ensureFixCycle(account);if(account.plan==="free")return 2;const elapsedDays=Math.floor((now.getTime()-cycleStart(account).getTime())/86400000);return FIX_RELEASE_DAYS.filter(day=>elapsedDays>=day).length*2;}
export function sessionCookie(token:string,secure:boolean){return `methis_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure?"; Secure":""}`;}
export function clearSessionCookie(secure:boolean){return `methis_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?"; Secure":""}`;}
export function cookieToken(cookie:string|undefined){return cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("methis_session="))?.slice("methis_session=".length);}
export async function register(email:string,password:string){const e=normalizeEmail(email);if(!/^\S+@\S+\.\S+$/.test(e))throw new Error("A valid email is required.");if(password.length<8)throw new Error("Password must contain at least 8 characters.");const list=await load();if(list.some(a=>a.email===e))throw new Error("An account with this email already exists.");const salt=randomBytes(16).toString("hex");const account:Account={id:randomUUID(),email:e,passwordHash:hash(password,salt),salt,plan:"free",createdAt:new Date().toISOString(),usage:{day:new Date().toISOString().slice(0,10),analyses:0,fixes:0}};list.push(account);await save();return {account,token:tokenFor(account)};}
export async function login(email:string,password:string){const e=normalizeEmail(email);const list=await load();const account=list.find(a=>a.email===e);if(!account||!timingSafeEqual(Buffer.from(account.passwordHash),Buffer.from(hash(password,account.salt))))throw new Error("Invalid email or password.");resetDailyUsage(account);await save();return {account,token:tokenFor(account)};}
export async function current(token:string|undefined){if(!token)return null;const data=verifyToken(token);if(!data)return null;const list=await load();const account=list.find(a=>a.id===data.id);if(!account)return null;resetDailyUsage(account);await save();return account;}
export async function consume(account:Account,kind:"analyses"|"fixes"){
  resetDailyUsage(account);
  if(kind==="analyses"){
    const limit=PLAN_LIMITS[account.plan].analysesPerDay;
    if(account.usage.analyses>=limit)throw new Error(`Daily analyses limit reached for the ${account.plan} plan.`);
    account.usage.analyses++;await save();return {used:account.usage.analyses,limit,period:"day" as const};
  }
  const released=releasedFixes(account),available=Math.max(0,released-account.usage.fixes);
  if(available<=0)throw new Error(account.plan==="pro"?"No Fix credit is currently available. New credits unlock on billing-cycle days 1, 10 and 15.":"No Fix credit is currently available. Free includes 2 Fixes per month.");
  account.usage.fixes++;await save();return {used:account.usage.fixes,released,availableAfter:available-1,limit:PLAN_LIMITS[account.plan].fixesPerMonth,period:"monthly" as const};
}
export function planInfo(){return Object.entries(PLAN_LIMITS).map(([plan,value])=>({plan,...value,fixReleaseDays:plan==="pro"?[...FIX_RELEASE_DAYS]:[0]}));}
export function publicAccount(account:Account){const released=releasedFixes(account);return {id:account.id,email:account.email,plan:account.plan,usage:{...account.usage,fixesReleased:released,fixesAvailable:Math.max(0,released-account.usage.fixes)},limits:PLAN_LIMITS[account.plan],billingCycleStartedAt:account.billingCycleStartedAt??null,fixReleaseDays:account.plan==="pro"?[...FIX_RELEASE_DAYS]:[0]};}
