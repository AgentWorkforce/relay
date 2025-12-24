var r={agents:[],messages:[],currentChannel:"general",currentThread:null,isConnected:!1,ws:null,reconnectAttempts:0},y=[];function O(t){return y.push(t),()=>{let e=y.indexOf(t);e>-1&&y.splice(e,1)}}function E(){y.forEach(t=>t())}function q(t){r.agents=t,E()}function N(t){r.messages=t,E()}function R(t){r.currentChannel=t,E()}function b(t){r.isConnected=t,t&&(r.reconnectAttempts=0),E()}function K(){r.reconnectAttempts++}function V(t){r.ws=t}function z(){let{messages:t,currentChannel:e}=r;return e==="general"?t:t.filter(s=>s.from===e||s.to===e)}function x(t){r.currentThread=t}function W(t){return r.messages.filter(e=>e.thread===t)}function F(t){return r.messages.filter(e=>e.thread===t).length}var U=null;function S(){let t=window.location.protocol==="https:"?"wss:":"ws:",e=new WebSocket(`${t}//${window.location.host}/ws`);e.onopen=()=>{b(!0)},e.onclose=()=>{b(!1);let s=Math.min(1e3*Math.pow(2,r.reconnectAttempts),3e4);K(),setTimeout(S,s)},e.onerror=s=>{console.error("WebSocket error:",s)},e.onmessage=s=>{try{let n=JSON.parse(s.data);ce(n)}catch(n){console.error("Failed to parse message:",n)}},V(e)}function ce(t){console.log("[WS] Received data:",{agentCount:t.agents?.length,messageCount:t.messages?.length}),t.agents&&(console.log("[WS] Setting agents:",t.agents.map(e=>e.name)),q(t.agents)),t.messages&&N(t.messages),U&&U(t)}async function A(t,e,s){try{let n={to:t,message:e};s&&(n.thread=s);let o=await fetch("/api/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(n)}),i=await o.json();return o.ok&&i.success?{success:!0}:{success:!1,error:i.error||"Failed to send message"}}catch{return{success:!1,error:"Network error - could not send message"}}}function L(t){if(!t)return!1;let e=Date.parse(t);return Number.isNaN(e)?!1:Date.now()-e<3e4}function l(t){if(!t)return"";let e=document.createElement("div");return e.textContent=t,e.innerHTML}function T(t){return new Date(t).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}function _(t){let e=new Date(t),s=new Date,n=new Date(s);return n.setDate(n.getDate()-1),e.toDateString()===s.toDateString()?"Today":e.toDateString()===n.toDateString()?"Yesterday":e.toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}function g(t){let e=["#e01e5a","#2bac76","#e8a427","#1264a3","#7c3aed","#0d9488","#dc2626","#9333ea","#ea580c","#0891b2"],s=0;for(let n=0;n<t.length;n++)s=t.charCodeAt(n)+((s<<5)-s);return e[Math.abs(s)%e.length]}function h(t){return t.substring(0,2).toUpperCase()}function C(t){if(!t)return"";let e=l(t);return e=e.replace(/```([\s\S]*?)```/g,"<pre>$1</pre>"),e=e.replace(/`([^`]+)`/g,"<code>$1</code>"),e=e.replace(/\n/g,"<br>"),e}var a,c=-1;function Q(){return a={connectionDot:document.getElementById("connection-dot"),channelsList:document.getElementById("channels-list"),agentsList:document.getElementById("agents-list"),messagesList:document.getElementById("messages-list"),currentChannelName:document.getElementById("current-channel-name"),channelTopic:document.getElementById("channel-topic"),onlineCount:document.getElementById("online-count"),messageInput:document.getElementById("message-input"),sendBtn:document.getElementById("send-btn"),boldBtn:document.getElementById("bold-btn"),emojiBtn:document.getElementById("emoji-btn"),searchTrigger:document.getElementById("search-trigger"),commandPaletteOverlay:document.getElementById("command-palette-overlay"),paletteSearch:document.getElementById("palette-search"),paletteResults:document.getElementById("palette-results"),paletteChannelsSection:document.getElementById("palette-channels-section"),paletteAgentsSection:document.getElementById("palette-agents-section"),paletteMessagesSection:document.getElementById("palette-messages-section"),typingIndicator:document.getElementById("typing-indicator"),threadPanelOverlay:document.getElementById("thread-panel-overlay"),threadPanelId:document.getElementById("thread-panel-id"),threadPanelClose:document.getElementById("thread-panel-close"),threadMessages:document.getElementById("thread-messages"),threadMessageInput:document.getElementById("thread-message-input"),threadSendBtn:document.getElementById("thread-send-btn"),mentionAutocomplete:document.getElementById("mention-autocomplete"),mentionAutocompleteList:document.getElementById("mention-autocomplete-list")},a}function I(){return a}function Y(){r.isConnected?a.connectionDot.classList.remove("offline"):a.connectionDot.classList.add("offline")}function G(){console.log("[UI] renderAgents called, agents:",r.agents.length,r.agents.map(e=>e.name));let t=r.agents.map(e=>{let n=L(e.lastSeen||e.lastActive)?"online":"",o=r.currentChannel===e.name,i=e.needsAttention?"needs-attention":"";return`
      <li class="channel-item ${o?"active":""} ${i}" data-agent="${l(e.name)}">
        <div class="agent-avatar" style="background: ${g(e.name)}">
          ${h(e.name)}
          <span class="presence-indicator ${n}"></span>
        </div>
        <span class="channel-name">${l(e.name)}</span>
        ${e.needsAttention?'<span class="attention-badge">Needs Input</span>':""}
      </li>
    `}).join("");a.agentsList.innerHTML=t||'<li class="channel-item" style="color: var(--text-muted); cursor: default;">No agents connected</li>',a.agentsList.querySelectorAll(".channel-item[data-agent]").forEach(e=>{e.addEventListener("click",()=>{let s=e.dataset.agent;s&&p(s)})}),de()}function k(){let t=z();if(t.length===0){a.messagesList.innerHTML=`
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="empty-state-title">No messages yet</div>
        <div class="empty-state-text">
          ${r.currentChannel==="general"?"Messages between agents will appear here":`Messages with ${r.currentChannel} will appear here`}
        </div>
      </div>
    `;return}let e="",s=null;t.forEach(n=>{let o=new Date(n.timestamp).toDateString();o!==s&&(e+=`
        <div class="date-divider">
          <span class="date-divider-text">${_(n.timestamp)}</span>
        </div>
      `,s=o);let i=n.to==="*",u=g(n.from),f=F(n.id),le=i?"@everyone":n.project?`<span class="project-badge">${l(n.project)}</span>@${l(n.to)}`:`@${l(n.to)}`;e+=`
      <div class="message ${i?"broadcast":""}" data-id="${l(n.id)}">
        <div class="message-avatar" style="background: ${u}">
          ${h(n.from)}
        </div>
        <div class="message-content">
          <div class="message-header">
            <span class="message-sender">@${l(n.from)}</span>
            <span class="message-recipient">
              \u2192 <span class="target">${le}</span>
            </span>
            <span class="message-timestamp">${T(n.timestamp)}</span>
          </div>
          <div class="message-body">${C(n.content)}</div>
          ${n.thread?`
            <div class="thread-indicator" data-thread="${l(n.thread)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Thread: ${l(n.thread)}
            </div>
          `:""}
          ${f>0?`
            <div class="reply-count-badge" data-thread="${l(n.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              ${f} ${f===1?"reply":"replies"}
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
    `}),a.messagesList.innerHTML=e,ue()}function p(t){R(t),a.channelsList.querySelectorAll(".channel-item").forEach(s=>{s.classList.toggle("active",s.dataset.channel===t)}),a.agentsList.querySelectorAll(".channel-item").forEach(s=>{s.classList.toggle("active",s.dataset.agent===t)});let e=document.querySelector(".channel-header-name .prefix");if(t==="general")a.currentChannelName.innerHTML="general",a.channelTopic.textContent="All agent communications",e&&(e.textContent="#");else{a.currentChannelName.innerHTML=l(t);let s=r.agents.find(n=>n.name===t);a.channelTopic.textContent=s?.status||"Direct messages",e&&(e.textContent="@")}a.messageInput.placeholder=t==="general"?"@AgentName message... (or @* to broadcast)":`@${t} your message here...`,k()}function X(){let t=r.agents.filter(e=>L(e.lastSeen||e.lastActive)).length;a.onlineCount.textContent=`${t} online`}function de(){let t=r.agents.map(n=>{let o=L(n.lastSeen||n.lastActive);return`
      <div class="palette-item" data-jump-agent="${l(n.name)}">
        <div class="palette-item-icon">
          <div class="agent-avatar" style="background: ${g(n.name)}; width: 20px; height: 20px; font-size: 9px;">
            ${h(n.name)}
            <span class="presence-indicator ${o?"online":""}"></span>
          </div>
        </div>
        <div class="palette-item-content">
          <div class="palette-item-title">${l(n.name)}</div>
          <div class="palette-item-subtitle">${o?"Online":"Offline"}</div>
        </div>
      </div>
    `}).join(""),e=a.paletteAgentsSection;e.querySelectorAll(".palette-item").forEach(n=>n.remove()),e.insertAdjacentHTML("beforeend",t),e.querySelectorAll(".palette-item[data-jump-agent]").forEach(n=>{n.addEventListener("click",()=>{let o=n.dataset.jumpAgent;o&&(p(o),m())})})}function Z(){a.paletteChannelsSection.querySelectorAll(".palette-item[data-jump-channel]").forEach(t=>{t.addEventListener("click",()=>{let e=t.dataset.jumpChannel;e&&(p(e),m())})})}function $(){a.commandPaletteOverlay.classList.add("visible"),a.paletteSearch.value="",a.paletteSearch.focus(),c=-1,H("")}function ee(){return Array.from(a.paletteResults.querySelectorAll(".palette-item")).filter(e=>e.style.display!=="none")}function J(){let t=ee();if(t.forEach(e=>e.classList.remove("selected")),c>=0&&c<t.length){let e=t[c];e.classList.add("selected"),e.scrollIntoView({block:"nearest",behavior:"smooth"})}}function te(t){let e=ee();if(e.length!==0)switch(t.key){case"ArrowDown":t.preventDefault(),c=c<e.length-1?c+1:0,J();break;case"ArrowUp":t.preventDefault(),c=c>0?c-1:e.length-1,J();break;case"Enter":t.preventDefault(),c>=0&&c<e.length&&me(e[c]);break}}function me(t){let e=t.dataset.command;if(e){e==="broadcast"?(a.messageInput.value="@* ",a.messageInput.focus()):e==="clear"&&(a.messagesList.innerHTML=""),m();return}let s=t.dataset.jumpChannel;if(s){p(s),m();return}let n=t.dataset.jumpAgent;if(n){p(n),m();return}let o=t.dataset.jumpMessage;if(o){let i=a.messagesList.querySelector(`[data-id="${o}"]`);i&&(i.scrollIntoView({behavior:"smooth",block:"center"}),i.classList.add("highlighted"),setTimeout(()=>i.classList.remove("highlighted"),2e3)),m();return}}function m(){a.commandPaletteOverlay.classList.remove("visible")}function H(t){let e=t.toLowerCase();if(c=-1,document.querySelectorAll(".palette-item[data-command]").forEach(s=>{let o=s.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";s.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-channel]").forEach(s=>{let o=s.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";s.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-agent]").forEach(s=>{let n=s.dataset.jumpAgent?.toLowerCase()||"";s.style.display=n.includes(e)?"flex":"none"}),e.length>=2){let s=r.messages.filter(n=>n.content.toLowerCase().includes(e)).slice(0,5);if(s.length>0){a.paletteMessagesSection.style.display="block";let n=s.map(i=>`
        <div class="palette-item" data-jump-message="${l(i.id)}">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${l(i.from)}</div>
            <div class="palette-item-subtitle">${l(i.content.substring(0,60))}${i.content.length>60?"...":""}</div>
          </div>
        </div>
      `).join("");a.paletteMessagesSection.querySelectorAll(".palette-item").forEach(i=>i.remove()),a.paletteMessagesSection.insertAdjacentHTML("beforeend",n)}else a.paletteMessagesSection.style.display="none"}else a.paletteMessagesSection.style.display="none"}function w(t){x(t),a.threadPanelId.textContent=t,a.threadPanelOverlay.classList.add("visible"),a.threadMessageInput.value="",B(t),a.threadMessageInput.focus()}function D(){x(null),a.threadPanelOverlay.classList.remove("visible")}function B(t){let e=W(t);if(e.length===0){a.threadMessages.innerHTML=`
      <div class="thread-empty">
        <p>No messages in this thread yet.</p>
        <p style="font-size: 12px; margin-top: 8px;">Start the conversation below!</p>
      </div>
    `;return}let s=e.map(n=>`
      <div class="thread-message">
        <div class="thread-message-header">
          <div class="thread-message-avatar" style="background: ${g(n.from)}">
            ${h(n.from)}
          </div>
          <span class="thread-message-sender">${l(n.from)}</span>
          <span class="thread-message-time">${T(n.timestamp)}</span>
        </div>
        <div class="thread-message-body">${C(n.content)}</div>
      </div>
    `).join("");a.threadMessages.innerHTML=s,a.threadMessages.scrollTop=a.threadMessages.scrollHeight}function ue(){a.messagesList.querySelectorAll(".thread-indicator").forEach(t=>{t.style.cursor="pointer",t.addEventListener("click",e=>{e.stopPropagation();let s=t.dataset.thread;s&&w(s)})}),a.messagesList.querySelectorAll(".reply-count-badge").forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let s=t.dataset.thread;s&&w(s)})}),a.messagesList.querySelectorAll('.message-action-btn[data-action="reply"]').forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let s=t.closest(".message")?.getAttribute("data-id");s&&w(s)})})}var d=0,M=[];function ne(t){let e=t.toLowerCase();M=r.agents.filter(n=>n.name.toLowerCase().includes(e)),d=0;let s="";("*".includes(e)||"everyone".includes(e)||"all".includes(e)||"broadcast".includes(e))&&(s+=`
      <div class="mention-autocomplete-item ${d===0&&M.length===0?"selected":""}" data-mention="*">
        <div class="agent-avatar" style="background: var(--accent-yellow);">*</div>
        <span class="mention-autocomplete-name">@everyone</span>
        <span class="mention-autocomplete-role">Broadcast to all</span>
      </div>
    `),M.forEach((n,o)=>{s+=`
      <div class="mention-autocomplete-item ${o===d?"selected":""}" data-mention="${l(n.name)}">
        <div class="agent-avatar" style="background: ${g(n.name)}">
          ${h(n.name)}
        </div>
        <span class="mention-autocomplete-name">@${l(n.name)}</span>
        <span class="mention-autocomplete-role">${l(n.role||"Agent")}</span>
      </div>
    `}),s===""&&(s='<div class="mention-autocomplete-item" style="color: var(--text-muted); cursor: default;">No matching agents</div>'),a.mentionAutocompleteList.innerHTML=s,a.mentionAutocomplete.classList.add("visible"),a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]").forEach(n=>{n.addEventListener("click",()=>{let o=n.dataset.mention;o&&j(o)})})}function v(){a.mentionAutocomplete.classList.remove("visible"),M=[],d=0}function se(){return a.mentionAutocomplete.classList.contains("visible")}function P(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]");e.length!==0&&(e[d]?.classList.remove("selected"),t==="down"?d=(d+1)%e.length:d=(d-1+e.length)%e.length,e[d]?.classList.add("selected"),e[d]?.scrollIntoView({block:"nearest"}))}function j(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]"),s=t;if(!s&&e.length>0&&(s=e[d]?.dataset.mention),!s){v();return}let n=a.messageInput,o=n.value,i=o.match(/^@\S*/);if(i){let u=`@${s} `;n.value=u+o.substring(i[0].length),n.selectionStart=n.selectionEnd=u.length}v(),n.focus()}function ae(){let t=a.messageInput,e=t.value,s=t.selectionStart,n=e.match(/^@(\S*)/);return n&&s<=n[0].length?n[1]:null}function oe(){let t=Q();O(()=>{Y(),G(),k(),X()}),pe(t),S()}function pe(t){t.channelsList.querySelectorAll(".channel-item").forEach(e=>{e.addEventListener("click",()=>{let s=e.dataset.channel;s&&p(s)})}),t.sendBtn.addEventListener("click",ie),t.messageInput.addEventListener("keydown",e=>{if(se()){if(e.key==="Tab"||e.key==="Enter"){e.preventDefault(),j();return}if(e.key==="ArrowUp"){e.preventDefault(),P("up");return}if(e.key==="ArrowDown"){e.preventDefault(),P("down");return}if(e.key==="Escape"){e.preventDefault(),v();return}}e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),ie())}),t.messageInput.addEventListener("input",()=>{t.messageInput.style.height="auto",t.messageInput.style.height=Math.min(t.messageInput.scrollHeight,200)+"px";let e=ae();e!==null?ne(e):v()}),t.messageInput.addEventListener("blur",()=>{setTimeout(()=>{v()},150)}),t.boldBtn.addEventListener("click",()=>{let e=t.messageInput,s=e.selectionStart,n=e.selectionEnd,o=e.value;if(s===n){let i=o.substring(0,s),u=o.substring(n);e.value=i+"**bold**"+u,e.selectionStart=s+2,e.selectionEnd=s+6}else{let i=o.substring(0,s),u=o.substring(s,n),f=o.substring(n);e.value=i+"**"+u+"**"+f,e.selectionStart=s,e.selectionEnd=n+4}e.focus()}),t.emojiBtn.addEventListener("click",()=>{let e=["\u{1F44D}","\u{1F44E}","\u2705","\u274C","\u{1F389}","\u{1F525}","\u{1F4A1}","\u26A0\uFE0F","\u{1F4DD}","\u{1F680}"],s=e[Math.floor(Math.random()*e.length)],n=t.messageInput,o=n.selectionStart,i=n.value;n.value=i.substring(0,o)+s+i.substring(o),n.selectionStart=n.selectionEnd=o+s.length,n.focus()}),t.searchTrigger.addEventListener("click",$),document.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="k"&&(e.preventDefault(),t.commandPaletteOverlay.classList.contains("visible")?m():$()),e.key==="Escape"&&m()}),t.commandPaletteOverlay.addEventListener("click",e=>{e.target===t.commandPaletteOverlay&&m()}),t.paletteSearch.addEventListener("input",e=>{let s=e.target;H(s.value)}),t.paletteSearch.addEventListener("keydown",te),document.querySelectorAll(".palette-item[data-command]").forEach(e=>{e.addEventListener("click",()=>{let s=e.dataset.command;s==="broadcast"?(t.messageInput.value="@* ",t.messageInput.focus()):s==="clear"&&(t.messagesList.innerHTML=""),m()})}),Z(),t.threadPanelClose.addEventListener("click",D),t.threadSendBtn.addEventListener("click",re),t.threadMessageInput.addEventListener("keydown",e=>{e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),re())}),document.addEventListener("keydown",e=>{e.key==="Escape"&&t.threadPanelOverlay.classList.contains("visible")&&D()})}function ge(t){let s=t.trim().match(/^@(\*|[^\s]+)\s+(.+)$/s);return s?{to:s[1],message:s[2].trim()}:null}async function ie(){let t=I(),e=t.messageInput.value.trim();if(!e)return;let s=ge(e);if(!s){alert('Message must start with @recipient (e.g., "@Lead hello" or "@* broadcast")');return}let{to:n,message:o}=s;t.sendBtn.disabled=!0;let i=await A(n,o);i.success?(t.messageInput.value="",t.messageInput.style.height="auto"):alert(i.error),t.sendBtn.disabled=!1}async function re(){let t=I(),e=t.threadMessageInput.value.trim(),s=r.currentThread;if(!e||!s)return;t.threadSendBtn.disabled=!0;let n=await A("*",e,s);n.success?(t.threadMessageInput.value="",B(s)):alert(n.error),t.threadSendBtn.disabled=!1}typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",oe):oe());export{oe as initApp};
//# sourceMappingURL=app.js.map
