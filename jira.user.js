// ==UserScript==
// @name         Jira
// @description  Show Jira ticket info on hover in Chatwoot
// @namespace    http://tampermonkey.net/
// @version      2
// @author       pushinviktor
// @match        *://app.chatwoot.com/*
// @updateURL    https://raw.githubusercontent.com/pushinviktor/Jira/main/jira.user.js
// @downloadURL  https://raw.githubusercontent.com/pushinviktor/Jira/main/jira.user.js
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      jira.deversin.com
// ==/UserScript==

(function() {
    'use strict';

    const JIRA_BASE = "https://jira.deversin.com";
    let popup = null;
    let hoverTimeout = null;
    let removeTimeout = null;
    let hoverTarget = null;
    let cache = {};

    GM_addStyle(`
        .jira-popup {
            position: absolute;
            background: white;
            border: 1px solid #ccc;
            border-radius: 6px;
            padding: 10px;
            z-index: 9999;
            width: 320px;
            font-family: Arial;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            max-height: 400px;
            overflow-y: auto;
        }
        .jira-btn {
            margin-top: 6px;
            padding: 6px;
            background: #0052cc;
            color: white;
            text-align: center;
            border-radius: 4px;
            cursor: pointer;
        }
        .jira-btn:hover {
            background: #0052cc;
            opacity: 0.8;
        }
    `);

    const displayFields = [
        { key: 'summary', label: 'Summary' },
        { key: 'resolution.name', label: 'Resolution' },
        { key: 'status.name', label: 'Status' },
        { key: 'created', label: 'Date' },
        { key: 'customfield_12301', label: 'Subject' },
        { key: 'serviceComment', label: 'Last comment' }
    ];

    function getNested(obj, path) {
        return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    }

    function formatDate(dateStr) {
        const d = new Date(dateStr);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }

    function extractTicket(text) {
        return text.match(/[A-Z]+-\d+/)?.[0] || null;
    }

    function extractTransaction(text) {
        const match = text.match(/\d{10,}/);
        return match ? match[0] : null;
    }

    function fetchTicket(ticket, cb) {
        if (cache[ticket]) return cb(cache[ticket]);
        GM_xmlhttpRequest({
            method: "GET",
            url: `${JIRA_BASE}/rest/api/2/issue/${ticket}`,
            headers: { "Accept": "application/json" },
            onload: res => {
                const data = res.status === 200 ? JSON.parse(res.responseText) : null;
                cache[ticket] = data;
                cb(data);
            },
            onerror: () => { cache[ticket] = null; cb(null); }
        });
    }

    function searchTicketByTransaction(txn, cb) {
        if (cache[`txn_${txn}`]) return cb(cache[`txn_${txn}`]);
        const url = `${JIRA_BASE}/rest/api/2/search?jql=text~"${txn}"&maxResults=1&fields=comment,summary,status,resolution,created,customfield_12301`;
        GM_xmlhttpRequest({
            method: "GET",
            url: url,
            headers: { "Accept": "application/json" },
            onload: res => {
                let data = null;
                if (res.status === 200) {
                    const result = JSON.parse(res.responseText);
                    data = result.issues[0] || null;
                }
                cache[`txn_${txn}`] = data;
                cb(data);
            },
            onerror: () => { cache[`txn_${txn}`] = null; cb(null); }
        });
    }

    function getOptimalPosition(rect) {
        const popup_width = 320;
        const popup_height = 250;
        const offset = 5;
        const margin = 10;

        let top = rect.bottom + window.scrollY + offset;
        let left = rect.left + window.scrollX;

        if (left + popup_width + margin > window.innerWidth + window.scrollX) {
            left = window.innerWidth + window.scrollX - popup_width - margin;
        }
        if (left < window.scrollX) left = window.scrollX + margin;
        if (top + popup_height + margin > window.innerHeight + window.scrollY) {
            top = rect.top + window.scrollY - popup_height - offset;
        }

        return { top, left };
    }

    function getLastServiceComment(comments) {
        const serviceComments = comments.filter(c => c.author && c.author.name === 'service_account');
        if (!serviceComments.length) return '';
        return serviceComments[serviceComments.length - 1].body;
    }

    function createPopup(rect, ticketData, textSelection) {
        if (popup) popup.remove();
        popup = document.createElement('div');
        popup.className = 'jira-popup';

        const pos = getOptimalPosition(rect);
        popup.style.top = `${pos.top}px`;
        popup.style.left = `${pos.left}px`;

        document.body.appendChild(popup);

        if (!ticketData || !ticketData.fields) {
            popup.innerHTML = `❌ No ticket found for "${textSelection}"`;
            return;
        }

        const fields = ticketData.fields;
        fields.serviceComment = getLastServiceComment(ticketData.fields.comment?.comments || []);

        let contentHTML = `<b>${ticketData.key}</b><br><br>`;
        displayFields.forEach(f => {
            const value = getNested(fields, f.key);
            if (value) contentHTML += `<b>${f.label}:</b> ${f.key === 'created' ? formatDate(value) : value}<br>`;
        });

        contentHTML += `<br><div class="jira-btn" data-ticket="${ticketData.key}">Open</div>`;
        popup.innerHTML = contentHTML;

        const btn = popup.querySelector('.jira-btn');
        if (btn) btn.onclick = () => window.open(`${JIRA_BASE}/browse/${ticketData.key}`, '_blank');

        popup.addEventListener('mouseenter', () => clearTimeout(removeTimeout));
        popup.addEventListener('mouseleave', () => scheduleRemove());
    }

    function scheduleRemove() {
        clearTimeout(removeTimeout);
        removeTimeout = setTimeout(() => {
            if (popup) { popup.remove(); popup = null; }
        }, 800);
    }

    document.body.addEventListener('mouseover', e => {
        clearTimeout(hoverTimeout);
        if (popup) return;

        const text = e.target.innerText || '';
        const ticket = extractTicket(text);
        const txn = extractTransaction(text);
        if (!ticket && !txn) return;

        hoverTarget = e.target;

        hoverTimeout = setTimeout(() => {
            const rect = hoverTarget.getBoundingClientRect();
            if (ticket) fetchTicket(ticket, data => createPopup(rect, data, text));
            else if (txn) searchTicketByTransaction(txn, data => createPopup(rect, data, text));
        }, 400);
    });

    document.body.addEventListener('mouseout', e => {
        clearTimeout(hoverTimeout);
        if (!popup) return;
        const related = e.relatedTarget;
        if (popup.contains(related) || related === hoverTarget) return;
        scheduleRemove();
    });

    window.addEventListener('scroll', () => {
        if (popup) { popup.remove(); popup = null; }
    });

})();
