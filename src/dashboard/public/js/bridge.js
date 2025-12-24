var r={projects:[],messages:[],selectedProjectId:null,isConnected:!1,ws:null,connectionStart:null},g=[];function S(e){return g.push(e),()=>{let s=g.indexOf(e);s>-1&&g.splice(s,1)}}function u(){g.forEach(e=>{try{e()}catch(s){console.error("[bridge-state] Listener error:",s)}})}function L(e){r.projects=e,u()}function b(e){r.messages=e,u()}function E(e){r.selectedProjectId=e,u()}function v(e){r.isConnected=e,e&&!r.connectionStart&&(r.connectionStart=Date.now()),u()}function j(e){r.ws=e}function h(){let e=[];return r.projects.forEach(s=>{(s.agents||[]).forEach(n=>{e.push({name:n.name,projectId:s.id,projectName:s.name||s.id,cli:n.cli})})}),e}function M(){return r.projects.filter(e=>e.connected)}function y(e){return r.projects.find(s=>s.id===e)}function x(){if(!r.connectionStart)return"--";let e=Date.now()-r.connectionStart,s=Math.floor(e/1e3);if(s<60)return`${s}s`;let n=Math.floor(s/60);return n<60?`${n}m`:`${Math.floor(n/60)}h ${n%60}m`}function c(e){if(!e)return"";let s=document.createElement("div");return s.textContent=e,s.innerHTML}function P(e){return new Date(e).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}var t;function C(){return{statusDot:document.getElementById("status-dot"),projectList:document.getElementById("project-list"),cardsGrid:document.getElementById("cards-grid"),emptyState:document.getElementById("empty-state"),messagesList:document.getElementById("messages-list"),searchBar:document.getElementById("search-bar"),paletteOverlay:document.getElementById("command-palette-overlay"),paletteSearch:document.getElementById("palette-search"),paletteResults:document.getElementById("palette-results"),paletteProjectsSection:document.getElementById("palette-projects-section"),paletteAgentsSection:document.getElementById("palette-agents-section"),channelName:document.getElementById("channel-name"),statAgents:document.getElementById("stat-agents"),statMessages:document.getElementById("stat-messages"),composerProject:document.getElementById("composer-project"),composerAgent:document.getElementById("composer-agent"),composerMessage:document.getElementById("composer-message"),composerSend:document.getElementById("composer-send"),composerStatus:document.getElementById("composer-status"),uptime:document.getElementById("uptime")}}function k(){t.statusDot.classList.toggle("offline",!r.isConnected)}function H(){let{projects:e,selectedProjectId:s}=r;if(!e||e.length===0){t.projectList.innerHTML='<li class="project-item" style="cursor: default; color: var(--text-muted);">No projects</li>',document.getElementById("project-count").textContent="0";return}document.getElementById("project-count").textContent=String(e.length),t.projectList.innerHTML=e.map(n=>`
    <li class="project-item ${n.connected?"connected":""} ${s===n.id?"active":""}" data-project-id="${c(n.id)}">
      <span class="project-status-dot"></span>
      <span class="project-name">${c(n.name||n.id)}</span>
      <button class="project-dashboard-btn" data-dashboard-project="${c(n.id)}" title="Open project dashboard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
          <line x1="9" y1="21" x2="9" y2="9"/>
        </svg>
      </button>
    </li>
  `).join("")}function A(){let{projects:e,selectedProjectId:s}=r;if(!e||e.length===0){t.cardsGrid.innerHTML="",t.cardsGrid.appendChild(t.emptyState),t.emptyState.style.display="flex";return}t.emptyState.style.display="none",t.cardsGrid.innerHTML=e.map(n=>{let o=n.agents||[],i=o.length>0?o.map(m=>`
          <div class="agent-item">
            <span class="agent-status-dot"></span>
            <span class="agent-name">${c(m.name)}</span>
            <span class="agent-cli">${c(m.cli||"")}</span>
          </div>
        `).join(""):'<div class="no-agents">No agents connected</div>',a=s===n.id;return`
      <div class="project-card ${n.connected?"":"offline"} ${a?"selected":""}" data-project-id="${c(n.id)}">
        <div class="card-header">
          <div class="card-title-group">
            <div class="card-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div>
              <div class="card-title">${c(n.name||n.id)}</div>
              <div class="card-path">${c(n.path||"")}</div>
            </div>
          </div>
          <div class="card-status ${n.connected?"online":n.reconnecting?"reconnecting":"offline"}">
            <span class="dot"></span>
            <span>${n.connected?"Online":n.reconnecting?"Reconnecting...":"Offline"}</span>
          </div>
        </div>

        <div class="agents-section">
          <div class="agents-header">
            <span class="agents-label">Agents</span>
            <span class="agents-count">${o.length} active</span>
          </div>
          <div class="agents-list">
            ${i}
          </div>
        </div>

        <div class="card-actions">
          <button class="card-action-btn" data-message-lead="${c(n.id)}" ${n.connected?"":"disabled"}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Message Lead
          </button>
          <button class="card-action-btn primary" data-open-dashboard="${c(n.id)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            Open Dashboard
          </button>
        </div>
      </div>
    `}).join("")}function D(){let{messages:e}=r;if(!e||e.length===0){t.messagesList.innerHTML='<div class="messages-empty"><p>No messages yet</p></div>';return}t.messagesList.innerHTML=e.slice(-50).reverse().map(s=>`
    <div class="message-item">
      <div class="message-route">
        <span class="route-tag">${c(s.sourceProject||"local")}</span>
        <span class="route-agent">${c(s.from)}</span>
        <span class="route-arrow">\u2192</span>
        <span class="route-agent">${c(s.to||"*")}</span>
        <span class="route-time">${P(s.timestamp)}</span>
      </div>
      <div class="message-body">${c(s.body||s.content||"")}</div>
    </div>
  `).join("")}function O(){let e=h();t.statAgents.textContent=String(e.length),t.statMessages.textContent=String(r.messages.length)}function N(){let e=M(),s=t.composerProject.value;t.composerProject.innerHTML='<option value="">Select a project...</option>'+e.map(n=>`<option value="${c(n.id)}">${c(n.name||n.id)}</option>`).join(""),s&&e.some(n=>n.id===s)?t.composerProject.value=s:r.selectedProjectId&&e.some(n=>n.id===r.selectedProjectId)&&(t.composerProject.value=r.selectedProjectId,p())}function p(){let e=t.composerProject.value;if(!e){t.composerAgent.innerHTML='<option value="">Select agent...</option>',t.composerAgent.disabled=!0,t.composerMessage.disabled=!0,t.composerSend.disabled=!0;return}let s=t.composerAgent.value,o=y(e)?.agents||[];t.composerAgent.innerHTML='<option value="">Select agent...</option><option value="*">* (Broadcast to all)</option><option value="lead">Lead</option>'+o.map(i=>`<option value="${c(i.name)}">${c(i.name)}</option>`).join(""),t.composerAgent.disabled=!1,s&&["*","lead",...o.map(a=>a.name)].includes(s)&&(t.composerAgent.value=s)}function l(){let e=!!t.composerProject.value,s=!!t.composerAgent.value,n=t.composerMessage.value.trim().length>0;t.composerMessage.disabled=!e||!s,t.composerSend.disabled=!e||!s||!n}async function w(){let e=t.composerProject.value,s=t.composerAgent.value,n=t.composerMessage.value.trim();if(!(!e||!s||!n)){t.composerSend.disabled=!0,t.composerStatus.textContent="Sending...",t.composerStatus.className="composer-status";try{let o=await fetch("/api/bridge/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:e,to:s,message:n})}),i=await o.json();if(o.ok&&i.success)t.composerStatus.textContent="Message sent!",t.composerStatus.className="composer-status success",t.composerMessage.value="",setTimeout(()=>{t.composerStatus.textContent="",t.composerStatus.className="composer-status"},2e3);else throw new Error(i.error||"Failed to send")}catch(o){t.composerStatus.textContent=o.message||"Failed to send message",t.composerStatus.className="composer-status error"}l()}}function R(){let{selectedProjectId:e}=r;if(e){let s=y(e);s&&(t.channelName.innerHTML=`
        <span class="back-link" id="back-to-all">\u2190 All Projects</span>
        <span class="project-title">${c(s.name||s.id)}</span>
      `)}else t.channelName.textContent="All Projects"}function f(e){E(e),e&&(t.composerProject.value=e,p(),l()),document.querySelectorAll(".project-card").forEach(s=>{s.classList.toggle("selected",s.dataset.projectId===e)})}function $(){t.paletteOverlay.classList.add("visible"),t.paletteSearch.value="",t.paletteSearch.focus(),B()}function d(){t.paletteOverlay.classList.remove("visible")}function B(){let e=t.paletteSearch.value.toLowerCase(),{projects:s}=r,n=e?s.filter(a=>(a.name||a.id).toLowerCase().includes(e)):s;n.length>0?t.paletteProjectsSection.innerHTML=`
      <div class="palette-section-title">Open Project Dashboard</div>
      ${n.map(a=>`
        <div class="palette-item" data-project="${c(a.id)}" data-action="open-dashboard">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${c(a.name||a.id)}</div>
            <div class="palette-item-subtitle">${a.connected?"Online":"Offline"} \xB7 ${(a.agents||[]).length} agents \xB7 Click to open dashboard</div>
          </div>
          <div class="palette-item-shortcut">
            <kbd>\u23CE</kbd>
          </div>
        </div>
      `).join("")}
    `:t.paletteProjectsSection.innerHTML='<div class="palette-section-title">Open Project Dashboard</div>';let o=h(),i=e?o.filter(a=>a.name.toLowerCase().includes(e)):o;i.length>0?t.paletteAgentsSection.innerHTML=`
      <div class="palette-section-title">Message Agent</div>
      ${i.map(a=>`
        <div class="palette-item" data-agent="${c(a.name)}" data-project="${c(a.projectId)}">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${c(a.name)}</div>
            <div class="palette-item-subtitle">${c(a.projectName)} \xB7 ${c(a.cli||"unknown")}</div>
          </div>
        </div>
      `).join("")}
    `:t.paletteAgentsSection.innerHTML='<div class="palette-section-title">Message Agent</div>'}function U(){t.searchBar.addEventListener("click",$),t.paletteOverlay.addEventListener("click",e=>{e.target===t.paletteOverlay&&d()}),t.paletteSearch.addEventListener("input",B),document.addEventListener("keydown",e=>{(e.metaKey||e.ctrlKey)&&e.key==="k"&&(e.preventDefault(),t.paletteOverlay.classList.contains("visible")?d():$()),e.key==="Escape"&&t.paletteOverlay.classList.contains("visible")&&d()}),t.paletteResults.addEventListener("click",e=>{let s=e.target.closest(".palette-item");if(!s)return;let n=s.dataset.command,o=s.dataset.project,i=s.dataset.agent,a=s.dataset.action;if(n==="broadcast")d(),t.composerMessage.focus(),t.composerStatus.textContent="Select a project and agent to send a message";else if(n==="refresh")d(),location.reload();else if(n==="go-dashboard")d(),window.location.href="/";else if(a==="open-dashboard"&&o)d(),window.location.href=`/project/${encodeURIComponent(o)}`;else if(i&&o)d(),t.composerProject.value=o,p(),setTimeout(()=>{t.composerAgent.value=i,l(),t.composerMessage.focus()},50);else if(o){d(),f(o);let m=document.querySelector(`.project-card[data-project-id="${o}"]`);m&&m.scrollIntoView({behavior:"smooth",block:"center"})}}),t.cardsGrid.addEventListener("click",e=>{let s=e.target,n=s.closest("[data-open-dashboard]");if(n){e.stopPropagation();let a=n.dataset.openDashboard;a&&(window.location.href=`/project/${encodeURIComponent(a)}`);return}let o=s.closest("[data-message-lead]");if(o&&!o.disabled){e.stopPropagation();let a=o.dataset.messageLead;a&&(t.composerProject.value=a,p(),setTimeout(()=>{t.composerAgent.value="lead",l(),t.composerMessage.focus()},50));return}let i=s.closest(".project-card");i&&f(i.dataset.projectId||null)}),t.projectList.addEventListener("click",e=>{let s=e.target,n=s.closest(".project-dashboard-btn");if(n){e.stopPropagation();let i=n.dataset.dashboardProject;i&&(window.location.href=`/project/${encodeURIComponent(i)}`);return}let o=s.closest(".project-item");o&&f(o.dataset.projectId||null)}),t.channelName.addEventListener("click",e=>{let s=e.target;(s.id==="back-to-all"||s.classList.contains("back-link"))&&f(null)}),t.composerProject.addEventListener("change",()=>{p(),l()}),t.composerAgent.addEventListener("change",l),t.composerMessage.addEventListener("input",l),t.composerSend.addEventListener("click",w),t.composerMessage.addEventListener("keydown",e=>{e.key==="Enter"&&!e.shiftKey&&!t.composerSend.disabled&&(e.preventDefault(),w())})}function T(){let e=window.location.protocol==="https:"?"wss:":"ws:",s=new WebSocket(`${e}//${window.location.host}/ws/bridge`);s.onopen=()=>{v(!0),j(s)},s.onclose=()=>{v(!1),j(null),setTimeout(T,3e3)},s.onerror=()=>{v(!1)},s.onmessage=n=>{try{let o=JSON.parse(n.data);L(o.projects||[]),b(o.messages||[])}catch(o){console.error("[bridge] Parse error:",o)}}}function I(){t=C(),S(()=>{k(),H(),A(),D(),O(),N(),R(),t.composerProject.value&&(p(),l())}),U(),T(),setInterval(()=>{t.uptime.textContent=`Uptime: ${x()}`},1e3)}typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",I):I());export{I as initBridgeApp};
//# sourceMappingURL=bridge.js.map
