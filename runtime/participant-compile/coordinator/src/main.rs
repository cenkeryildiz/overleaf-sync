// SPDX-License-Identifier: AGPL-3.0-only
// Trusted host supplies authenticated identities and time; this process never executes TeX or opens project files.
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, io::{self, BufRead, Read, Write}};

#[derive(Clone)]
struct Job { project: String, user: String, digest: String, state: &'static str, worker: String, lease: u64, until: u64, attempts: u8 }
struct Worker { project: String, user: String, until: u64 }
#[derive(Default)]
struct Pool { jobs: HashMap<String, Job>, workers: HashMap<String, Worker>, queue: VecDeque<String>, latest: HashMap<(String,String), String>, serial: u64 }
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, &'static str> { v[key].as_str().filter(|s| !s.is_empty() && s.len() <= 128).ok_or("invalid metadata") }
impl Pool {
    fn expire(&mut self, now: u64) {
        self.workers.retain(|_,w| w.until > now);
        let latest = &self.latest;
        for (id,job) in &mut self.jobs {
            if job.state == "leased" && (job.until <= now || !self.workers.contains_key(&job.worker)) {
                job.worker.clear();
                if latest.get(&(job.project.clone(),job.user.clone())) != Some(id) { job.state="superseded"; }
                else if job.attempts >= 3 { job.state="failed"; }
                else { job.state="queued"; self.queue.push_back(id.clone()); }
            }
        }
    }
    fn current(&self,id:&str) -> bool { self.jobs.get(id).is_some_and(|j| self.latest.get(&(j.project.clone(),j.user.clone())).is_some_and(|v|v==id)) }
    fn worker(&mut self, request:&Value, now:u64) -> Result<(String,String), &'static str> {
        let token=field(request,"worker")?;
        let worker=self.workers.get_mut(token).ok_or("worker unavailable")?;
        if worker.user != field(request,"user")? || worker.project != field(request,"project")? { return Err("identity mismatch"); }
        worker.until=now+45000; Ok((token.to_string(),worker.project.clone()))
    }
    fn apply(&mut self, request:&Value) -> Result<Value,&'static str> {
        let now=request["now"].as_u64().ok_or("invalid clock")?; self.expire(now);
        match field(request,"op")? {
            "join" => {
                if self.workers.len()>=32 {return Err("worker capacity reached");}
                let token=field(request,"worker")?.to_string();
                if self.workers.contains_key(&token) {return Err("worker already registered");}
                self.workers.insert(token,Worker{user:field(request,"user")?.into(),project:field(request,"project")?.into(),until:now+45000}); Ok(json!({"joined":true}))
            },
            "queue" => {
                if self.jobs.len()>=64 {return Err("job capacity reached");}
                let id=field(request,"job")?.to_string();if self.jobs.contains_key(&id){return Err("duplicate job");}
                let project=field(request,"project")?.to_string();let user=field(request,"user")?.to_string();
                let digest=field(request,"digest")?.to_string();
                let key=(project.clone(),user.clone());
                if let Some(previous)=self.latest.insert(key,id.clone()) { if let Some(job)=self.jobs.get_mut(&previous) {job.state="superseded";} }
                self.jobs.insert(id.clone(),Job{project,user,digest,state:"queued",worker:String::new(),lease:0,until:now+180000,attempts:0});self.queue.push_back(id);
                Ok(json!({"queued":true}))
            },
            "claim" => {
                let (worker,project)=self.worker(request,now)?;
                if self.jobs.values().any(|j|j.state=="leased"&&j.worker==worker){return Ok(json!({"job":null}));}
                self.queue.retain(|id|self.jobs.get(id).is_some_and(|j|j.state=="queued"));
                let next=self.queue.iter().position(|id|self.jobs[id].project==project);
                if let Some(position)=next {
                    let id=self.queue.remove(position).unwrap();self.serial+=1;
                    let job=self.jobs.get_mut(&id).unwrap();job.state="leased";job.worker=worker;job.lease=self.serial;job.until=now+30000;job.attempts+=1;
                    Ok(json!({"job":id,"lease":job.lease,"digest":job.digest}))
                } else {Ok(json!({"job":null}))}
            },
            "heartbeat" => {
                let (worker,_)=self.worker(request,now)?;let id=field(request,"job")?;
                if !self.current(id){return Err("superseded job");}
                let job=self.jobs.get_mut(id).ok_or("job unavailable")?;
                if job.state!="leased"||job.worker!=worker||request["lease"].as_u64()!=Some(job.lease){return Err("invalid lease");}
                job.until=now+30000;Ok(json!({"renewed":true}))
            },
            "finish"|"fail" => {
                let (worker,_)=self.worker(request,now)?;let id=field(request,"job")?;
                if !self.current(id){return Err("superseded job");}
                let job=self.jobs.get_mut(id).ok_or("job unavailable")?;
                if job.state!="leased"||job.worker!=worker||request["lease"].as_u64()!=Some(job.lease)||field(request,"digest")?!=job.digest {return Err("invalid result identity");}
                job.state=if request["op"]=="finish"{"ready"}else{"failed"};Ok(json!({"accepted":true}))
            },
            "commit" => {
                let id=field(request,"job")?;if !self.current(id){return Err("superseded job");}
                let job=self.jobs.get_mut(id).ok_or("job unavailable")?;if job.state!="ready" {return Err("result unavailable");}
                job.state="complete";Ok(json!({"accepted":true}))
            },
            "status" => {let id=field(request,"job")?;let state=self.jobs.get(id).map(|j|j.state).unwrap_or("missing");Ok(json!({"state":state}))},
            "leave" => {self.worker(request,now)?;self.workers.remove(field(request,"worker")?);self.expire(now);Ok(json!({"left":true}))},
            "drop" => {let id=field(request,"job")?;self.queue.retain(|queued|queued!=id);if let Some(job)=self.jobs.remove(id){let key=(job.project,job.user);if self.latest.get(&key).is_some_and(|v|v==id){self.latest.remove(&key);}}Ok(json!({"dropped":true}))},
            _=>Err("unsupported operation")
        }
    }
}
fn main(){let mut pool=Pool::default();let mut input=io::stdin().lock();loop{let mut bytes=Vec::new();match (&mut input).take(65537).read_until(b'\n',&mut bytes){Ok(0)=>break,Ok(n) if n<=65536&&bytes.last()==Some(&b'\n')=>{},_=>break}let request:Value=match serde_json::from_slice(&bytes){Ok(v)=>v,Err(_)=>break};let result=match pool.apply(&request){Ok(value)=>json!({"id":request["id"],"ok":true,"value":value}),Err(error)=>json!({"id":request["id"],"ok":false,"error":error})};if writeln!(io::stdout(),"{result}").is_err(){break;}}}
