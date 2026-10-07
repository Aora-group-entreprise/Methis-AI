import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalQwenModel } from "./model.js";
import { CommandVerifier } from "./verifier.js";
import { MethisEngine } from "./engine.js";
import { loadGitHubRepository } from "./github.js";
import { createFixPullRequest } from "./github-fix.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(root, "web");
const engine = new MethisEngine(new LocalQwenModel(), new CommandVerifier());
const port = Number(process.env.PORT || 3000);

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
  res.end(JSON.stringify(body));
}

async function body(req: import("node:http").IncomingMessage): Promise<any> {
  let raw=""; for await (const chunk of req) raw+=chunk.toString();
  if(raw.length>100_000) throw new Error("Request too large.");
  return raw ? JSON.parse(raw) : {};
}

function repositoryInput(value: string) {
  const raw=value.trim();
  if(raw.startsWith("github:")||raw.startsWith("github-fix:")) return raw;
  return "github:"+raw;
}

async function api(req: import("node:http").IncomingMessage,res: import("node:http").ServerResponse) {
  try {
    if(req.method==="GET" && req.url==="/api/health") return json(res,200,{ok:true,engine:"Méthis AI"});
    if(req.method!=="POST") return json(res,405,{error:"Method not allowed"});

    const data=await body(req);
    if(req.url==="/api/analyze"){
      const input=repositoryInput(String(data.repository||""));
      if(!input.slice(input.indexOf(":")+1).trim()) return json(res,400,{error:"Repository is required."});
      const remote=await loadGitHubRepository(input.slice(input.indexOf(":")+1));
      return json(res,200,{engine:"Méthis AI",mode:"github-scan",repository:remote.repository,files:remote.files.length,languages:[...new Set(remote.files.map(f=>f.language))],status:"ready"});
    }

    if(req.url==="/api/github-fix"){
      const repository=String(data.repository||"").trim();
      const problem=String(data.problem||"").trim() || "Analyze this repository and identify the smallest safe fix for the reported problem.";
      if(!repository) return json(res,400,{error:"Repository is required."});
      const remote=await loadGitHubRepository(repository.replace(/^github(-fix)?:/,""));
      const plan=await new LocalQwenModel().plan({
        repository:{root:`github://${remote.repository.owner}/${remote.repository.name}`,files:remote.files,packageManagers:[],testCommands:[],buildCommands:[]},
        bug:{description:problem}
      });
      if(!plan.edits.length) return json(res,422,{error:"Méthis produced no safe edits. No Pull Request was created.",summary:plan.summary});
      const pr=await createFixPullRequest(remote.repository,plan);
      return json(res,201,{mode:"github-fix",repository:remote.repository,summary:plan.summary,changedFiles:[...new Set(plan.edits.map(e=>e.path))],branch:pr.branch,commit:pr.commit,pullRequest:pr.prUrl,pullRequestNumber:pr.prNumber,verification:pr.verification});
    }

    if(req.url==="/api/fix"){
      const input=repositoryInput(String(data.repository||""));
      const bug=String(data.problem||"Analyze this repository and identify the smallest safe fix for the reported problem.");
      if(!input.slice(input.indexOf(":")+1).trim()) return json(res,400,{error:"Repository is required."});
      if(input.startsWith("github-fix:")) return json(res,400,{error:"Use the GitHub Fix action for remote pull requests."});
      const local=String(data.localPath||"").trim();
      if(!local) return json(res,400,{error:"A local workspace path is required for verified local fixes."});
      const result=await engine.fix(local,{description:bug});
      return json(res,200,result);
    }

    return json(res,404,{error:"Unknown endpoint."});
  } catch(error) {
    return json(res,500,{error:error instanceof Error?error.message:"Request failed."});
  }
}

async function staticFile(req: import("node:http").IncomingMessage,res: import("node:http").ServerResponse){
  const requested=(req.url||"/").split("?")[0];
  const relative=requested==="/" ? "index.html" : requested.replace(/^\/+/, "");
  const file=normalize(join(webRoot,relative));
  if(!file.startsWith(webRoot) || !existsSync(file)) return json(res,404,{error:"Not found"});
  const types:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon"};
  res.writeHead(200,{"content-type":types[extname(file)]||"application/octet-stream"});
  res.end(await readFile(file));
}

createServer(async(req,res)=>{
  if((req.url||"").startsWith("/api/")) return api(req,res);
  return staticFile(req,res);
}).listen(port,()=>console.log(`Méthis AI web server listening on http://localhost:${port}`));
