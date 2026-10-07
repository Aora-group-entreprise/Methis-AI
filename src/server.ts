import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalQwenModel } from "./model.js";
import { CommandVerifier } from "./verifier.js";
import { MethisEngine } from "./engine.js";
import { loadGitHubRepository } from "./github.js";
import { createFixPullRequest } from "./github-fix.js";
import { bearerToken, consume, current, planInfo, publicAccount } from "./auth.js";
import { PLAN_LIMITS } from "./limits.js";

const root=fileURLToPath(new URL("..",import.meta.url)), webRoot=join(root,"web");
const model=new LocalQwenModel(), engine=new MethisEngine(model,new CommandVerifier());
const port=Number(process.env.PORT||3000), secureCookies=process.env.NODE_ENV==="production";

function json(res:import("node:http").ServerResponse,status:number,body:unknown,extra:Record<string,string>={}){res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...extra});res.end(JSON.stringify(body));}
async function body(req:import("node:http").IncomingMessage):Promise<any>{let raw="";for await(const chunk of req)raw+=chunk.toString();if(raw.length>100_000)throw new Error("Request too large.");return raw?JSON.parse(raw):{};}
function repositoryInput(value:string){const raw=value.trim();if(raw.startsWith("github:")||raw.startsWith("github-fix:"))return raw;return "github:"+raw;}
async function account(req:import("node:http").IncomingMessage){return current(cookieToken(req.headers.cookie));}
function requireAccount(a:Awaited<ReturnType<typeof account>>){if(!a)throw new Error("Authentication required.");return a;}

async function api(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse){
  try{
    if(req.method==="GET"&&req.url==="/api/health"){const qwen=await model.health();return json(res,200,{ok:true,engine:"Méthis AI",model:model.config.model,qwen});}
    if(req.method==="GET"&&req.url==="/api/plans")return json(res,200,{plans:planInfo()});
    if(req.method==="GET"&&req.url==="/api/auth/me"){const a=await account(req);return json(res,200,{authenticated:!!a,account:a?publicAccount(a):null});}
    if(req.method==="POST"&&req.url==="/api/auth/register"){const d=await body(req);const result=await register(String(d.email||""),String(d.password||""));return json(res,201,{account:publicAccount(result.account)},{set-cookie:sessionCookie(result.token,secureCookies)});}
    if(req.method==="POST"&&req.url==="/api/auth/login"){const d=await body(req);const result=await login(String(d.email||""),String(d.password||""));return json(res,200,{account:publicAccount(result.account)},{set-cookie:sessionCookie(result.token,secureCookies)});}
    if(req.method==="POST"&&req.url==="/api/auth/logout")return json(res,200,{ok:true},{ "set-cookie":clearSessionCookie(secureCookies) });
    if(req.method!=="POST")return json(res,405,{error:"Method not allowed"});

    const a=requireAccount(await account(req));
    const data=await body(req);
    const problemText=String(data.problem||"").trim();
    if((req.url==="/api/fix"||req.url==="/api/github-fix") && (/\b(fix|repair|fixe)\b.*\b(all|everything|entire|whole|toute|tout)\b|\b(all|everything|entire|whole|toute|tout)\b.*\b(app|application|repo|repository|codebase)\b|^(fix|repair|fixe|répare|corrige)\s+(the\s+)?(app|application|repo|repository|codebase|projet|tout)\s*$/i.test(problemText))){
      return json(res,400,{error:"One Fix credit can repair one specific bug only. Describe one concrete bug; Méthis will not perform a whole-app repair."});
    }

    if(req.url==="/api/analyze"){
      const input=repositoryInput(String(data.repository||""));
      if(!input.slice(input.indexOf(":")+1).trim())return json(res,400,{error:"Repository is required."});
      const remote=await loadGitHubRepository(input.slice(input.indexOf(":")+1));
      const usage=await consume(a,"analyses");
      const languages=[...new Set(remote.files.map(f=>f.language))];
      return json(res,200,{engine:"Méthis AI",model:model.config.model,mode:"github-scan",repository:remote.repository,files:remote.files.length,languages,status:"ready",usage,plan:a.plan});
    }

    if(req.url==="/api/github-fix"){
      if(!PLAN_LIMITS[a.plan].githubFix)return json(res,403,{error:"GitHub Fix is available on the Méthis Pro plan only."});
      const repository=String(data.repository||"").trim(),problem=problemText||"Describe one specific bug to fix.";
      if(!repository)return json(res,400,{error:"Repository is required."});
      const remote=await loadGitHubRepository(repository.replace(/^github(-fix)?:/,""));
      const plan=await model.plan({repository:{root:`github://${remote.repository.owner}/${remote.repository.name}`,files:remote.files,packageManagers:[],testCommands:[],buildCommands:[]},bug:{description:problem}});
      if(!plan.edits.length)return json(res,422,{error:"Méthis produced no safe edits. No Fix credit was consumed and no Pull Request was created.",summary:plan.summary});
      const pr=await createFixPullRequest(remote.repository,plan);
      const usage=await consume(a,"fixes");
      return json(res,201,{mode:"github-fix",repository:remote.repository,summary:plan.summary,changedFiles:[...new Set(plan.edits.map(e=>e.path))],branch:pr.branch,commit:pr.commit,pullRequest:pr.prUrl,pullRequestNumber:pr.prNumber,verification:pr.verification,usage,plan:a.plan});
    }

    if(req.url==="/api/fix"){
      const local=String(data.localPath||"").trim(),bug=problemText||"Describe one specific bug to fix.";
      if(process.env.METHIS_ENABLE_LOCAL_FIX!=="true")return json(res,403,{error:"Local verified fixes are disabled on the web server. Use an approved workspace integration."});
      if(!local)return json(res,400,{error:"A local workspace path is required for verified local fixes."});
      const configuredRoot=process.env.METHIS_WORKSPACE_ROOT;
      if(!configuredRoot)return json(res,500,{error:"METHIS_WORKSPACE_ROOT is not configured."});
      const workspaceRoot=resolve(configuredRoot), target=resolve(local), rel=relative(workspaceRoot,target);
      if(rel.startsWith(".."+sep)||isAbsolute(rel))return json(res,403,{error:"The requested workspace is outside the configured Méthis workspace root."});
      const result=await engine.fix(target,{description:bug});
      if(!result.verified)return json(res,422,{...result,error:"Méthis could not verify the fix. No Fix credit was consumed.",plan:a.plan});
      const usage=await consume(a,"fixes");
      return json(res,200,{...result,usage,plan:a.plan});
    }
    return json(res,404,{error:"Unknown endpoint."});
  }catch(error){const message=error instanceof Error?error.message:"Request failed.";const status=/Authentication required|Invalid email|already exists|valid email|Password must|Invalid email or password/.test(message)?401:/Daily |No Fix credit|Fix credit/.test(message)?429:500;return json(res,status,{error:message});}
}

async function staticFile(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse){
  const requested=(req.url||"/").split("?")[0],relative=requested==="/"?"index.html":requested.replace(/^\/+/, ""),file=normalize(join(webRoot,relative));
  if(!file.startsWith(webRoot)||!existsSync(file))return json(res,404,{error:"Not found"});
  const types:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon"};
  res.writeHead(200,{"content-type":types[extname(file)]||"application/octet-stream"});res.end(await readFile(file));
}
createServer(async(req,res)=>{if((req.url||"").startsWith("/api/"))return api(req,res);return staticFile(req,res);}).listen(port,()=>console.log(`Méthis AI web server listening on http://localhost:${port}`));
