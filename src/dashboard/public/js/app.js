var i={agents:[],messages:[],currentChannel:"general",currentThread:null,isConnected:!1,ws:null,reconnectAttempts:0,viewMode:"local",fleetData:null},S=[];function Y(t){return S.push(t),()=>{let e=S.indexOf(t);e>-1&&S.splice(e,1)}}function h(){S.forEach(t=>t())}function G(t){i.agents=t,h()}function X(t){i.messages=t,h()}function Z(t){i.currentChannel=t,h()}function k(t){i.isConnected=t,t&&(i.reconnectAttempts=0),h()}function ee(){i.reconnectAttempts++}function te(t){i.ws=t}function ne(){let{messages:t,currentChannel:e}=i;return e==="general"?t:t.filter(n=>n.from===e||n.to===e)}function $(t){i.currentThread=t}function se(t){return i.messages.filter(e=>e.thread===t)}function ae(t){return i.messages.filter(e=>e.thread===t).length}function oe(t){i.viewMode=t,h()}function L(){return i.viewMode}function re(t){i.fleetData=t,h()}function x(){return i.fleetData}var ie=null;function B(){let t=window.location.protocol==="https:"?"wss:":"ws:",e=new WebSocket(`${t}//${window.location.host}/ws`);e.onopen=()=>{k(!0)},e.onclose=()=>{k(!1);let n=Math.min(1e3*Math.pow(2,i.reconnectAttempts),3e4);ee(),setTimeout(B,n)},e.onerror=n=>{console.error("WebSocket error:",n)},e.onmessage=n=>{try{let s=JSON.parse(n.data);Be(s)}catch(s){console.error("Failed to parse message:",s)}},te(e)}function Be(t){console.log("[WS] Received data:",{agentCount:t.agents?.length,messageCount:t.messages?.length,hasFleet:!!t.fleet}),t.agents&&(console.log("[WS] Setting agents:",t.agents.map(e=>e.name)),G(t.agents)),t.messages&&X(t.messages),t.fleet&&(console.log("[WS] Setting fleet data:",{servers:t.fleet.servers?.length,agents:t.fleet.agents?.length}),re(t.fleet)),ie&&ie(t)}async function D(t,e,n){try{let s={to:t,message:e};n&&(s.thread=n);let o=await fetch("/api/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(s)}),r=await o.json();return o.ok&&r.success?{success:!0}:{success:!1,error:r.error||"Failed to send message"}}catch{return{success:!1,error:"Network error - could not send message"}}}function M(t){if(!t)return!1;let e=Date.parse(t);return Number.isNaN(e)?!1:Date.now()-e<45e3}function l(t){if(!t)return"";let e=document.createElement("div");return e.textContent=t,e.innerHTML}function H(t){return new Date(t).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}function le(t){let e=new Date(t),n=new Date,s=new Date(n);return s.setDate(s.getDate()-1),e.toDateString()===n.toDateString()?"Today":e.toDateString()===s.toDateString()?"Yesterday":e.toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}function v(t){let e=["#e01e5a","#2bac76","#e8a427","#1264a3","#7c3aed","#0d9488","#dc2626","#9333ea","#ea580c","#0891b2"],n=0;for(let s=0;s<t.length;s++)n=t.charCodeAt(s)+((n<<5)-n);return e[Math.abs(n)%e.length]}function f(t){return t.substring(0,2).toUpperCase()}function P(t){if(!t)return"";let e=l(t);return e=e.replace(/```(\w+)?\n([\s\S]*?)```/g,(n,s,o)=>`<pre><code>${o.trim()}</code></pre>`),e=e.replace(/```([^`\n]+)```/g,"<pre><code>$1</code></pre>"),e=e.replace(/`([^`]+)`/g,"<code>$1</code>"),e=e.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>"),e=e.replace(/__([^_]+)__/g,"<strong>$1</strong>"),e=e.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g,"<em>$1</em>"),e}var j=[],a,d=-1;function de(){return a={connectionDot:document.getElementById("connection-dot"),channelsList:document.getElementById("channels-list"),agentsList:document.getElementById("agents-list"),messagesList:document.getElementById("messages-list"),currentChannelName:document.getElementById("current-channel-name"),channelTopic:document.getElementById("channel-topic"),onlineCount:document.getElementById("online-count"),messageInput:document.getElementById("message-input"),sendBtn:document.getElementById("send-btn"),boldBtn:document.getElementById("bold-btn"),emojiBtn:document.getElementById("emoji-btn"),searchTrigger:document.getElementById("search-trigger"),commandPaletteOverlay:document.getElementById("command-palette-overlay"),paletteSearch:document.getElementById("palette-search"),paletteResults:document.getElementById("palette-results"),paletteChannelsSection:document.getElementById("palette-channels-section"),paletteAgentsSection:document.getElementById("palette-agents-section"),paletteMessagesSection:document.getElementById("palette-messages-section"),typingIndicator:document.getElementById("typing-indicator"),threadPanelOverlay:document.getElementById("thread-panel-overlay"),threadPanelId:document.getElementById("thread-panel-id"),threadPanelClose:document.getElementById("thread-panel-close"),threadMessages:document.getElementById("thread-messages"),threadMessageInput:document.getElementById("thread-message-input"),threadSendBtn:document.getElementById("thread-send-btn"),mentionAutocomplete:document.getElementById("mention-autocomplete"),mentionAutocompleteList:document.getElementById("mention-autocomplete-list"),spawnBtn:document.getElementById("spawn-btn"),spawnModalOverlay:document.getElementById("spawn-modal-overlay"),spawnModalClose:document.getElementById("spawn-modal-close"),spawnNameInput:document.getElementById("spawn-name-input"),spawnCliInput:document.getElementById("spawn-cli-input"),spawnTaskInput:document.getElementById("spawn-task-input"),spawnSubmitBtn:document.getElementById("spawn-submit-btn"),spawnStatus:document.getElementById("spawn-status"),viewToggle:document.getElementById("view-toggle"),viewToggleLocal:document.querySelector('[data-view="local"]'),viewToggleFleet:document.querySelector('[data-view="fleet"]'),peerCount:document.getElementById("peer-count"),serversSection:document.getElementById("servers-section"),serversList:document.getElementById("servers-list")},a}function O(){return a}function ue(){i.isConnected?a.connectionDot.classList.remove("offline"):a.connectionDot.classList.add("offline")}function b(){console.log("[UI] renderAgents called, agents:",i.agents.length,i.agents.map(n=>n.name));let t=new Set(j.map(n=>n.name)),e=i.agents.map(n=>{let o=M(n.lastSeen||n.lastActive)?"online":"",r=i.currentChannel===n.name,c=n.needsAttention?"needs-attention":"",u=t.has(n.name),E=u?`
        <svg class="spawned-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="Spawned from dashboard">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      `:"",C=u?`
        <button class="release-btn" title="Release agent" data-release="${l(n.name)}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `:"";return`
      <li class="channel-item ${r?"active":""} ${c}" data-agent="${l(n.name)}" ${u?'title="Spawned from dashboard"':""}>
        <div class="agent-avatar" style="background: ${u?"var(--accent-green)":v(n.name)}">
          ${f(n.name)}
          <span class="presence-indicator ${o}"></span>
        </div>
        <span class="channel-name">${l(n.name)}</span>
        ${E}
        ${n.needsAttention?'<span class="attention-badge">Needs Input</span>':""}
        ${C}
      </li>
    `}).join("");a.agentsList.innerHTML=e||'<li class="channel-item" style="color: var(--text-muted); cursor: default;">No agents connected</li>',a.agentsList.querySelectorAll(".channel-item[data-agent]").forEach(n=>{n.addEventListener("click",s=>{if(s.target.closest(".release-btn"))return;let o=n.dataset.agent;o&&g(o)})}),a.agentsList.querySelectorAll(".release-btn[data-release]").forEach(n=>{n.addEventListener("click",async s=>{s.stopPropagation();let o=n.dataset.release;o&&confirm(`Release agent "${o}"? This will terminate the agent.`)&&await Le(o)})}),me()}function q(){let t=ne();if(t.length===0){a.messagesList.innerHTML=`
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="empty-state-title">No messages yet</div>
        <div class="empty-state-text">
          ${i.currentChannel==="general"?"Messages between agents will appear here":`Messages with ${i.currentChannel} will appear here`}
        </div>
      </div>
    `;return}let e="",n=null;t.forEach(s=>{let o=new Date(s.timestamp).toDateString();o!==n&&(e+=`
        <div class="date-divider">
          <span class="date-divider-text">${le(s.timestamp)}</span>
        </div>
      `,n=o);let r=s.to==="*",c=v(s.from),u=ae(s.id),E=r?"@everyone":s.project?`<span class="project-badge">${l(s.project)}</span>@${l(s.to)}`:`@${l(s.to)}`;e+=`
      <div class="message ${r?"broadcast":""}" data-id="${l(s.id)}">
        <div class="message-avatar" style="background: ${c}">
          ${f(s.from)}
        </div>
        <div class="message-content">
          <div class="message-header">
            <span class="message-sender">@${l(s.from)}</span>
            <span class="message-recipient">
              \u2192 <span class="target">${E}</span>
            </span>
            <span class="message-timestamp">${H(s.timestamp)}</span>
          </div>
          <div class="message-body">${P(s.content)}</div>
          ${s.thread?`
            <div class="thread-indicator" data-thread="${l(s.thread)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Thread: ${l(s.thread)}
            </div>
          `:""}
          ${u>0?`
            <div class="reply-count-badge" data-thread="${l(s.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              ${u} ${u===1?"reply":"replies"}
            </div>
          `:""}
        </div>
        <div class="message-actions">
          <button class="message-action-btn" data-action="reply" title="Reply in thread">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="message-action-btn" title="Add reaction">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
        </div>
      </div>
    `}),a.messagesList.innerHTML=e,He()}function g(t){Z(t),a.channelsList.querySelectorAll(".channel-item").forEach(n=>{n.classList.toggle("active",n.dataset.channel===t)}),a.agentsList.querySelectorAll(".channel-item").forEach(n=>{n.classList.toggle("active",n.dataset.agent===t)});let e=document.querySelector(".channel-header-name .prefix");if(t==="general")a.currentChannelName.innerHTML="general",a.channelTopic.textContent="All agent communications",e&&(e.textContent="#");else{a.currentChannelName.innerHTML=l(t);let n=i.agents.find(s=>s.name===t);a.channelTopic.textContent=n?.status||"Direct messages",e&&(e.textContent="@")}a.messageInput.placeholder=t==="general"?"@AgentName message... (or @* to broadcast)":`Message ${t}... (@ not required)`,q()}function pe(){let t=i.agents.filter(e=>M(e.lastSeen||e.lastActive)).length;a.onlineCount.textContent=`${t} online`}function me(){let t=i.agents.map(s=>{let o=M(s.lastSeen||s.lastActive);return`
      <div class="palette-item" data-jump-agent="${l(s.name)}">
        <div class="palette-item-icon">
          <div class="agent-avatar" style="background: ${v(s.name)}; width: 20px; height: 20px; font-size: 9px;">
            ${f(s.name)}
            <span class="presence-indicator ${o?"online":""}"></span>
          </div>
        </div>
        <div class="palette-item-content">
          <div class="palette-item-title">${l(s.name)}</div>
          <div class="palette-item-subtitle">${o?"Online":"Offline"}</div>
        </div>
      </div>
    `}).join(""),e=a.paletteAgentsSection;e.querySelectorAll(".palette-item").forEach(s=>s.remove()),e.insertAdjacentHTML("beforeend",t),e.querySelectorAll(".palette-item[data-jump-agent]").forEach(s=>{s.addEventListener("click",()=>{let o=s.dataset.jumpAgent;o&&(g(o),m())})})}function ge(){a.paletteChannelsSection.querySelectorAll(".palette-item[data-jump-channel]").forEach(t=>{t.addEventListener("click",()=>{let e=t.dataset.jumpChannel;e&&(g(e),m())})})}function V(){a.commandPaletteOverlay.classList.add("visible"),a.paletteSearch.value="",a.paletteSearch.focus(),d=-1,R("")}function ve(){return Array.from(a.paletteResults.querySelectorAll(".palette-item")).filter(e=>e.style.display!=="none")}function ce(){let t=ve();if(t.forEach(e=>e.classList.remove("selected")),d>=0&&d<t.length){let e=t[d];e.classList.add("selected"),e.scrollIntoView({block:"nearest",behavior:"smooth"})}}function fe(t){let e=ve();if(e.length!==0)switch(t.key){case"ArrowDown":t.preventDefault(),d=d<e.length-1?d+1:0,ce();break;case"ArrowUp":t.preventDefault(),d=d>0?d-1:e.length-1,ce();break;case"Enter":t.preventDefault(),d>=0&&d<e.length&&De(e[d]);break}}function De(t){let e=t.dataset.command;if(e){e==="broadcast"?(a.messageInput.value="@* ",a.messageInput.focus()):e==="clear"&&(a.messagesList.innerHTML=""),m();return}let n=t.dataset.jumpChannel;if(n){g(n),m();return}let s=t.dataset.jumpAgent;if(s){g(s),m();return}let o=t.dataset.jumpMessage;if(o){let r=a.messagesList.querySelector(`[data-id="${o}"]`);r&&(r.scrollIntoView({behavior:"smooth",block:"center"}),r.classList.add("highlighted"),setTimeout(()=>r.classList.remove("highlighted"),2e3)),m();return}}function m(){a.commandPaletteOverlay.classList.remove("visible")}function R(t){let e=t.toLowerCase();if(d=-1,document.querySelectorAll(".palette-item[data-command]").forEach(n=>{let o=n.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";n.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-channel]").forEach(n=>{let o=n.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";n.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-agent]").forEach(n=>{let s=n.dataset.jumpAgent?.toLowerCase()||"";n.style.display=s.includes(e)?"flex":"none"}),e.length>=2){let n=i.messages.filter(s=>s.content.toLowerCase().includes(e)).slice(0,5);if(n.length>0){a.paletteMessagesSection.style.display="block";let s=n.map(r=>`
        <div class="palette-item" data-jump-message="${l(r.id)}">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${l(r.from)}</div>
            <div class="palette-item-subtitle">${l(r.content.substring(0,60))}${r.content.length>60?"...":""}</div>
          </div>
        </div>
      `).join("");a.paletteMessagesSection.querySelectorAll(".palette-item").forEach(r=>r.remove()),a.paletteMessagesSection.insertAdjacentHTML("beforeend",s)}else a.paletteMessagesSection.style.display="none"}else a.paletteMessagesSection.style.display="none"}function F(t){$(t),a.threadPanelId.textContent=t,a.threadPanelOverlay.classList.add("visible"),a.threadMessageInput.value="",_(t),a.threadMessageInput.focus()}function K(){$(null),a.threadPanelOverlay.classList.remove("visible")}function _(t){let e=se(t);if(e.length===0){a.threadMessages.innerHTML=`
      <div class="thread-empty">
        <p>No messages in this thread yet.</p>
        <p style="font-size: 12px; margin-top: 8px;">Start the conversation below!</p>
      </div>
    `;return}let n=e.map(s=>`
      <div class="thread-message">
        <div class="thread-message-header">
          <div class="thread-message-avatar" style="background: ${v(s.from)}">
            ${f(s.from)}
          </div>
          <span class="thread-message-sender">${l(s.from)}</span>
          <span class="thread-message-time">${H(s.timestamp)}</span>
        </div>
        <div class="thread-message-body">${P(s.content)}</div>
      </div>
    `).join("");a.threadMessages.innerHTML=n,a.threadMessages.scrollTop=a.threadMessages.scrollHeight}function He(){a.messagesList.querySelectorAll(".thread-indicator").forEach(t=>{t.style.cursor="pointer",t.addEventListener("click",e=>{e.stopPropagation();let n=t.dataset.thread;n&&F(n)})}),a.messagesList.querySelectorAll(".reply-count-badge").forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let n=t.dataset.thread;n&&F(n)})}),a.messagesList.querySelectorAll('.message-action-btn[data-action="reply"]').forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let n=t.closest(".message")?.getAttribute("data-id");n&&F(n)})})}var p=0,A=[];function he(t){let e=t.toLowerCase();A=i.agents.filter(s=>s.name.toLowerCase().includes(e)),p=0;let n="";("*".includes(e)||"everyone".includes(e)||"all".includes(e)||"broadcast".includes(e))&&(n+=`
      <div class="mention-autocomplete-item ${p===0&&A.length===0?"selected":""}" data-mention="*">
        <div class="agent-avatar" style="background: var(--accent-yellow);">*</div>
        <span class="mention-autocomplete-name">@everyone</span>
        <span class="mention-autocomplete-role">Broadcast to all</span>
      </div>
    `),A.forEach((s,o)=>{n+=`
      <div class="mention-autocomplete-item ${o===p?"selected":""}" data-mention="${l(s.name)}">
        <div class="agent-avatar" style="background: ${v(s.name)}">
          ${f(s.name)}
        </div>
        <span class="mention-autocomplete-name">@${l(s.name)}</span>
        <span class="mention-autocomplete-role">${l(s.role||"Agent")}</span>
      </div>
    `}),n===""&&(n='<div class="mention-autocomplete-item" style="color: var(--text-muted); cursor: default;">No matching agents</div>'),a.mentionAutocompleteList.innerHTML=n,a.mentionAutocomplete.classList.add("visible"),a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]").forEach(s=>{s.addEventListener("click",()=>{let o=s.dataset.mention;o&&W(o)})})}function y(){a.mentionAutocomplete.classList.remove("visible"),A=[],p=0}function ye(){return a.mentionAutocomplete.classList.contains("visible")}function U(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]");e.length!==0&&(e[p]?.classList.remove("selected"),t==="down"?p=(p+1)%e.length:p=(p-1+e.length)%e.length,e[p]?.classList.add("selected"),e[p]?.scrollIntoView({block:"nearest"}))}function W(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]"),n=t;if(!n&&e.length>0&&(n=e[p]?.dataset.mention),!n){y();return}let s=a.messageInput,o=s.value,r=o.match(/^@\S*/);if(r){let c=`@${n} `;s.value=c+o.substring(r[0].length),s.selectionStart=s.selectionEnd=c.length}y(),s.focus()}function we(){let t=a.messageInput,e=t.value,n=t.selectionStart,s=e.match(/^@(\S*)/);return s&&n<=s[0].length?s[1]:null}function Ee(){a.spawnModalOverlay.classList.add("visible"),a.spawnNameInput.value="",a.spawnCliInput.value="claude",a.spawnTaskInput.value="",a.spawnStatus.textContent="",a.spawnStatus.className="spawn-status",a.spawnNameInput.focus()}function w(){a.spawnModalOverlay.classList.remove("visible")}async function z(){let t=a.spawnNameInput.value.trim(),e=a.spawnCliInput.value.trim()||"claude",n=a.spawnTaskInput.value.trim();if(!t)return a.spawnStatus.textContent="Agent name is required",a.spawnStatus.className="spawn-status error",{success:!1,error:"Agent name is required"};a.spawnSubmitBtn.disabled=!0,a.spawnStatus.textContent="Spawning agent...",a.spawnStatus.className="spawn-status loading";try{let s=await fetch("/api/spawn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:t,cli:e,task:n})}),o=await s.json();if(s.ok&&o.success)return a.spawnStatus.textContent=`Agent "${t}" spawned successfully!`,a.spawnStatus.className="spawn-status success",await T(),setTimeout(()=>{w()},1e3),{success:!0};throw new Error(o.error||"Failed to spawn agent")}catch(s){return a.spawnStatus.textContent=s.message||"Failed to spawn agent",a.spawnStatus.className="spawn-status error",{success:!1,error:s.message}}finally{a.spawnSubmitBtn.disabled=!1}}async function T(){try{let e=await(await fetch("/api/spawned")).json();e.success&&Array.isArray(e.agents)&&(j=e.agents,b())}catch(t){console.error("[UI] Failed to fetch spawned agents:",t)}}async function Le(t){try{let n=await(await fetch(`/api/spawned/${encodeURIComponent(t)}`,{method:"DELETE"})).json();n.success?await T():console.error("[UI] Failed to release agent:",n.error)}catch(e){console.error("[UI] Failed to release agent:",e)}}function Me(){a.viewToggleLocal?.addEventListener("click",()=>{N("local")}),a.viewToggleFleet?.addEventListener("click",()=>{N("fleet")})}function N(t){oe(t),a.viewToggleLocal?.classList.toggle("active",t==="local"),a.viewToggleFleet?.classList.toggle("active",t==="fleet"),a.serversSection&&(a.serversSection.style.display=t==="fleet"?"block":"none"),b(),t==="fleet"&&J()}function be(){let t=x(),e=t&&t.servers.length>0;a.viewToggle&&(a.viewToggle.style.display=e?"flex":"none"),a.peerCount&&t&&(a.peerCount.textContent=String(t.servers.length)),!e&&L()==="fleet"&&N("local")}function J(){let t=x();if(!t||t.servers.length===0){a.serversList&&(a.serversList.innerHTML='<li class="server-item" style="color: var(--text-muted); cursor: default;">No peer servers connected</li>');return}let e=t.servers.map(n=>{let s=n.id===t.localServerId,o=n.connected?"":"offline";return`
      <li class="server-item" data-server="${l(n.id)}">
        <div class="server-icon" style="${s?"background: var(--accent-primary);":""}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <span class="status-dot ${o}"></span>
        </div>
        <span class="server-name">${l(n.name)}${s?" (local)":""}</span>
        <span class="agent-count">${n.agentCount}</span>
      </li>
    `}).join("");a.serversList&&(a.serversList.innerHTML=e)}function Se(){let t=L(),e=x();if(t!=="fleet"||!e){b();return}let n=e.agents,s=new Set(j.map(r=>r.name)),o=n.map(r=>{let c=M(r.lastSeen||r.lastActive),u=c?"online":"",E=i.currentChannel===r.name,C=r.needsAttention?"needs-attention":"",I=s.has(r.name),Q=r.isLocal,Ce=`
      <span class="server-badge ${Q?"local":""}">
        <span class="server-dot ${c?"":"offline"}"></span>
        ${l(r.serverName||r.server)}
      </span>
    `,Ie=Q?"":`
      <span class="server-indicator" title="${l(r.serverName)}"></span>
    `,ke=I?`
      <svg class="spawned-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="Spawned from dashboard">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    `:"",$e=I?`
      <button class="release-btn" title="Release agent" data-release="${l(r.name)}">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `:"";return`
      <li class="channel-item ${E?"active":""} ${C}" data-agent="${l(r.name)}" data-server="${l(r.server)}">
        <div class="agent-avatar" style="background: ${I?"var(--accent-green)":v(r.name)}">
          ${f(r.name)}
          <span class="presence-indicator ${u}"></span>
          ${Ie}
        </div>
        ${Ce}
        <span class="channel-name">${l(r.name)}</span>
        ${ke}
        ${r.needsAttention?'<span class="attention-badge">Needs Input</span>':""}
        ${$e}
      </li>
    `}).join("");a.agentsList.innerHTML=o||'<li class="channel-item" style="color: var(--text-muted); cursor: default;">No agents in fleet</li>',Pe(),me()}function Pe(){a.agentsList.querySelectorAll(".channel-item[data-agent]").forEach(t=>{t.addEventListener("click",e=>{if(e.target.closest(".release-btn"))return;let n=t.dataset.agent;n&&g(n)})}),a.agentsList.querySelectorAll(".release-btn[data-release]").forEach(t=>{t.addEventListener("click",async e=>{e.stopPropagation();let n=t.dataset.release;n&&confirm(`Release agent "${n}"? This will terminate the agent.`)&&await Le(n)})})}function xe(){let t=de();Y(()=>{ue(),L()==="fleet"?(Se(),J()):b(),q(),pe(),be()}),Fe(t),Me(),B(),T()}function Fe(t){t.channelsList.querySelectorAll(".channel-item").forEach(e=>{e.addEventListener("click",()=>{let n=e.dataset.channel;n&&g(n)})}),t.sendBtn.addEventListener("click",Ae),t.messageInput.addEventListener("keydown",e=>{if(ye()){if(e.key==="Tab"||e.key==="Enter"){e.preventDefault(),W();return}if(e.key==="ArrowUp"){e.preventDefault(),U("up");return}if(e.key==="ArrowDown"){e.preventDefault(),U("down");return}if(e.key==="Escape"){e.preventDefault(),y();return}}e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),Ae())}),t.messageInput.addEventListener("input",()=>{t.messageInput.style.height="auto",t.messageInput.style.height=Math.min(t.messageInput.scrollHeight,200)+"px";let e=we();e!==null?he(e):y()}),t.messageInput.addEventListener("blur",()=>{setTimeout(()=>{y()},150)}),t.boldBtn.addEventListener("click",()=>{let e=t.messageInput,n=e.selectionStart,s=e.selectionEnd,o=e.value;if(n===s){let r=o.substring(0,n),c=o.substring(s);e.value=r+"**bold**"+c,e.selectionStart=n+2,e.selectionEnd=n+6}else{let r=o.substring(0,n),c=o.substring(n,s),u=o.substring(s);e.value=r+"**"+c+"**"+u,e.selectionStart=n,e.selectionEnd=s+4}e.focus()}),t.emojiBtn.addEventListener("click",()=>{let e=["\u{1F44D}","\u{1F44E}","\u2705","\u274C","\u{1F389}","\u{1F525}","\u{1F4A1}","\u26A0\uFE0F","\u{1F4DD}","\u{1F680}"],n=e[Math.floor(Math.random()*e.length)],s=t.messageInput,o=s.selectionStart,r=s.value;s.value=r.substring(0,o)+n+r.substring(o),s.selectionStart=s.selectionEnd=o+n.length,s.focus()}),t.searchTrigger.addEventListener("click",V),document.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="k"&&(e.preventDefault(),t.commandPaletteOverlay.classList.contains("visible")?m():V()),e.key==="Escape"&&m()}),t.commandPaletteOverlay.addEventListener("click",e=>{e.target===t.commandPaletteOverlay&&m()}),t.paletteSearch.addEventListener("input",e=>{let n=e.target;R(n.value)}),t.paletteSearch.addEventListener("keydown",fe),document.querySelectorAll(".palette-item[data-command]").forEach(e=>{e.addEventListener("click",()=>{let n=e.dataset.command;n==="broadcast"?(t.messageInput.value="@* ",t.messageInput.focus()):n==="clear"&&(t.messagesList.innerHTML=""),m()})}),ge(),t.threadPanelClose.addEventListener("click",K),t.threadSendBtn.addEventListener("click",Te),t.threadMessageInput.addEventListener("keydown",e=>{e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),Te())}),document.addEventListener("keydown",e=>{e.key==="Escape"&&t.threadPanelOverlay.classList.contains("visible")&&K()}),t.spawnBtn.addEventListener("click",Ee),t.spawnModalClose.addEventListener("click",w),document.getElementById("spawn-cancel-btn")?.addEventListener("click",w),t.spawnModalOverlay.addEventListener("click",e=>{e.target===t.spawnModalOverlay&&w()}),document.addEventListener("keydown",e=>{e.key==="Escape"&&t.spawnModalOverlay.classList.contains("visible")&&w()}),t.spawnSubmitBtn.addEventListener("click",z),t.spawnNameInput.addEventListener("keydown",e=>{e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),z())})}function Ne(t){let n=t.trim().match(/^@(\*|[^\s]+)\s+(.+)$/s);return n?{to:n[1],message:n[2].trim()}:null}async function Ae(){let t=O(),e=t.messageInput.value.trim();if(!e)return;let n,s,o=i.currentChannel!=="general",r=Ne(e);if(r)n=r.to,s=r.message;else if(o)n=i.currentChannel,s=e;else{alert('Message must start with @recipient (e.g., "@Lead hello" or "@* broadcast")');return}t.sendBtn.disabled=!0;let c=await D(n,s);c.success?(t.messageInput.value="",t.messageInput.style.height="auto"):alert(c.error),t.sendBtn.disabled=!1}async function Te(){let t=O(),e=t.threadMessageInput.value.trim(),n=i.currentThread;if(!e||!n)return;t.threadSendBtn.disabled=!0;let s=await D("*",e,n);s.success?(t.threadMessageInput.value="",_(n)):alert(s.error),t.threadSendBtn.disabled=!1}typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",xe):xe());export{xe as initApp};
//# sourceMappingURL=app.js.map
