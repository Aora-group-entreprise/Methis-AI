import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

export type Plan = "free" | "pro" | "team";
export interface Account { id:string; email:string; passwordHash:string; salt:string; plan:Plan; createdAt:string; usage:{day:string; analyses:number; fixes:number}; }
const dataFile=join(process.cwd(),"data","accounts.json");
const secret=process.env.METHIS_SESSION_SECRET || randomBytes(32).toString("hex");
const limits:Record<Plan,{analyses:number;fixes:number}>={free:{analyses:10,fixes:0},pro:{analyses:100,fixes:50},team:{analyses:500,fixes:250}};
let accounts:Account[]|null=null;

async function load(){if(accounts)return accounts;try{accounts=JSON.parse(await readFile(dataFile,"utf8")) as Account[]}catch{accounts=[]}return accounts;}
async function save(){await mkdir(dirname(dataFile),{recursive:true});await writeFile(dataFile,JSON.stringify(accounts??[],null,2),"utf8");}
function normalizeEmail(email:string){return email.trim().toLowerCase();}
function hash(password:string,salt:string){return scryptSync(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString("hex");}
function tokenFor(account:Account){const payload=Buffer.from(JSON.stringify({id:account.id,email:account.email,exp:Date.now()+7*86400000})).toString("base64url");const sig=createHmac("sha256",secret).update(payload).digest("base64url");return payload+"."+sig;}
function verifyToken(token:string){const [payload,sig]=token.split(".");if(!payload||!sig)return null;const expected=createHmac("sha256",secret).update(payload).digest("base64url");if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;try{const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));if(!data.id||data.exp<Date.now())return null;return data as {id:string;email:string;exp:number};}catch{return null;}}
function resetUsage(account:Account){const day=new Date().toISOString().slice(0,10);if(account.usage.day!==day)account.usage={day,analyses:0,fixes:0};}
export function sessionCookie(token:string,secure:boolean){return `methis_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure?"; Secure":""}`;}
export function clearSessionCookie(secure:boolean){return `methis_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?"; Secure":""}`;}
export function cookieToken(cookie:string|undefined){return cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("methis_session="))?.slice("methis_session=".length);}
export async function register(email:string,password:string){const e=normalizeEmail(email);if(!/^\S+@\S+\.\S+$/.test(e))throw new Error("A valid email is required.");if(password.length<8)throw new Error("Password must contain at least 8 characters.");const list=await load();if(list.some(a=>a.email===e))throw new Error("An account with this email already exists.");const salt=randomBytes(16).toString("hex");const account:Account={id:randomUUID(),email:e,passwordHash:hash(password,salt),salt,plan:"free",createdAt:new Date().toISOString(),usage:{day:new Date().toISOString().slice(0,10),analyses:0,fixes:0}};list.push(account);await save();return {account,token:tokenFor(account)};}
export async function login(email:string,password:string){const e=normalizeEmail(email);const list=await load();const account=list.find(a=>a.email===e);if(!account||!timingSafeEqual(Buffer.from(account.passwordHash),Buffer.from(hash(password,account.salt))))throw new Error("Invalid email or password.");resetUsage(account);await save();return {account,token:tokenFor(account)};}
export async function current(token:string|undefined){if(!token)return null;const data=verifyToken(token);if(!data)return null;const list=await load();const account=list.find(a=>a.id===data.id);if(!account)return null;resetUsage(account);await save();return account;}
export async function consume(account:Account,kind:"analyses"|"fixes"){resetUsage(account);const limit=limits[account.plan][kind];if(account.usage[kind]>=limit)throw new Error(`Daily ${kind} limit reached for the ${account.plan} plan.`);account.usage[kind]++;await save();return {used:account.usage[kind],limit};}
export function planInfo(){return Object.entries(limits).map(([plan,value])=>({plan,...value}));}
export function publicAccount(account:Account){return {id:account.id,email:account.email,plan:account.plan,usage:account.usage,limits:limits[account.plan]};}
