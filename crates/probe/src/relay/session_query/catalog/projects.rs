use super::*;
const TTL: std::time::Duration=std::time::Duration::from_secs(300);
const BATCH: usize=32;
impl CatalogIndex {
    pub fn needed_projects(&mut self)->Vec<String> {self.needed_projects_at(std::time::Instant::now())}
    pub(in crate::relay::session_query) fn needed_projects_at(&mut self,now:std::time::Instant)->Vec<String> {
        for _ in 0..BATCH {
            let Some(std::cmp::Reverse((deadline,_)))=self.project_expiry.peek() else {break;};
            if *deadline>now {break;}
            let Some(std::cmp::Reverse((deadline,cwd)))=self.project_expiry.pop() else {break;};
            if self.project_resolved_at.get(&cwd).is_some_and(|at| *at+TTL==deadline) && self.pending_projects.insert(cwd.clone()) {self.project_queue.push_back(cwd);}
        }
        for cwd in std::mem::take(&mut self.project_in_flight).into_iter().rev() {self.project_queue.push_front(cwd);}
        let limit=if self.projects_seeded {BATCH} else {self.project_queue.len()};
        self.projects_seeded=true;
        let requested=self.project_queue.drain(..self.project_queue.len().min(limit)).collect::<Vec<_>>();
        self.project_in_flight=requested.clone();requested
    }
    pub fn resolve_projects(&mut self, projects:HashMap<String,Option<String>>)->Result<(),RpcError> {
        for cwd in std::mem::take(&mut self.project_in_flight) {if !projects.contains_key(&cwd) {self.project_queue.push_back(cwd);}}
        for (cwd,project) in projects {
            self.pending_projects.remove(&cwd);
            let now=std::time::Instant::now();
            self.project_resolved_at.insert(cwd.clone(),now);
            self.project_expiry.push(std::cmp::Reverse((now+TTL,cwd.clone())));
            let previous=self.projects.insert(cwd.clone(),project.clone());
            if previous.as_ref()==Some(&project) {continue;}
            self.update_project(&cwd,project)?;
        }
        Ok(())
    }
    fn update_project(&mut self,cwd:&str,project:Option<String>)->Result<(),RpcError> {
        let keys=self.by_cwd.get(cwd).cloned().unwrap_or_default();
        for key in keys {
            if let Some(mut row)=self.index.get(&key)? {
                if let Some(upload)=row.upload.as_mut().filter(|u|u.cwd.as_deref()==Some(cwd)) {upload.project=Some(project.clone().unwrap_or_default());}
                self.index.put(row)?;
            }
        }
        Ok(())
    }
}
