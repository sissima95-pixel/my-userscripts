// ==UserScript==
// @name         SDS ASIN Keyword Downloader
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  自动批量查询ASIN关键词数据并下载
// @match        https://superset.sds.advertising.amazon.dev/superset/dashboard/2/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let asinGroups = [];
    let currentIndex = 0;
    let groupCounter = 0;
    let failedGroups = [];
    let exportFormat = 'csv';
    let isPaused = false;
    let isStopped = false;

    let currentAsin = '';

    function hookDownloadRename() {
        // 拦截 window.open
        const origOpen = window.open;
        window.open = function (url, ...rest) {
            if (currentAsin && url && typeof url === 'string' &&
                (url.includes('/api/') || url.includes('chart/data') || url.includes('export') ||
                 url.includes('csv') || url.includes('excel') || url.includes('results'))) {
                interceptDownload(url);
                return null;
            }
            return origOpen.call(window, url, ...rest);
        };

        // 拦截 form submit（某些导出用隐藏 form POST）
        const origSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function () {
            if (currentAsin && (this.action.includes('/api/') || this.action.includes('chart/data') || this.action.includes('export'))) {
                const formData = new FormData(this);
                interceptDownloadPost(this.action, formData);
                return;
            }
            return origSubmit.call(this);
        };

        // 拦截动态创建的 <a> 的 click
        const origAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            const href = this.href || '';
            if (currentAsin && (href.includes('/api/') || href.includes('chart/data') || href.includes('export'))) {
                if (this.target === '_blank' || this.hasAttribute('download')) {
                    interceptDownload(href);
                    return;
                }
            }
            return origAnchorClick.call(this);
        };
    }

    function interceptDownload(url) {
        const ext = exportFormat === 'csv' ? 'csv' : 'xlsx';
        const filename = `${currentAsin}.${ext}`;

        fetch(url, { credentials: 'include' })
            .then(resp => {
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return resp.blob();
            })
            .then(blob => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
                addLog(`已重命名下载: ${filename}`);
            })
            .catch(err => {
                console.error('拦截下载失败:', err);
                addLog(`重命名失败，使用原始下载: ${err.message}`);
                const origOpen = window.__origOpen || window.open;
                origOpen.call(window, url, '_blank');
            });
    }

    function setupLinkObserver() {
        const observer = new MutationObserver(mutations => {
            if (!currentAsin) return;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.tagName === 'A' || node.nodeName === 'A') {
                        const href = node.href || '';
                        if (href.includes('/api/') || href.includes('chart/data') || href.includes('export')) {
                            const ext = exportFormat === 'csv' ? 'csv' : 'xlsx';
                            node.setAttribute('download', `${currentAsin}.${ext}`);
                            if (node.target === '_blank') node.removeAttribute('target');
                        }
                    }
                    if (node.querySelectorAll) {
                        const links = node.querySelectorAll('a[href*="/api/"], a[href*="chart/data"], a[href*="export"]');
                        links.forEach(link => {
                            const ext = exportFormat === 'csv' ? 'csv' : 'xlsx';
                            link.setAttribute('download', `${currentAsin}.${ext}`);
                            if (link.target === '_blank') link.removeAttribute('target');
                        });
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function interceptDownloadPost(url, formData) {
        const ext = exportFormat === 'csv' ? 'csv' : 'xlsx';
        const filename = `${currentAsin}.${ext}`;

        fetch(url, { method: 'POST', body: formData, credentials: 'include' })
            .then(resp => {
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return resp.blob();
            })
            .then(blob => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
                addLog(`已重命名下载: ${filename}`);
            })
            .catch(err => {
                console.error('拦截 POST 下载失败:', err);
            });
    }

    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'asin-downloader-panel';
        panel.innerHTML = `
            <div style="font-weight:bold;font-size:15px;margin-bottom:12px;border-bottom:1px solid #e8e8e8;padding-bottom:8px;">SDS ASIN Keyword Downloader</div>
            <div id="asin-dl-tip" style="font-size:11px;color:#fa8c16;background:#fff7e6;border:1px solid #ffd591;border-radius:4px;padding:6px 8px;margin-bottom:10px;">首次使用：请点击地址栏弹窗拦截图标，选择「始终允许」此站点弹窗/下载。<br>提醒：每次请先手动在左侧选择好时间范围和站点。</div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#666;display:block;margin-bottom:4px;">导出格式</label>
                <select id="asin-dl-format" style="width:100%;padding:6px 8px;border:1px solid #d9d9d9;border-radius:4px;font-size:13px;">
                    <option value="csv">CSV</option>
                    <option value="excel">Excel</option>
                </select>
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#666;display:block;margin-bottom:4px;">分组查询（空行分隔不同组，每组一起查询）</label>
                <textarea id="asin-dl-group-input" rows="6" placeholder="每组 ASIN 之间用空行隔开&#10;B08XXX&#10;B09YYY&#10;&#10;B07ZZZ&#10;B06AAA" style="width:100%;padding:8px;border:1px solid #d9d9d9;border-radius:4px;font-size:12px;font-family:monospace;resize:vertical;box-sizing:border-box;"></textarea>
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:12px;color:#666;display:block;margin-bottom:4px;">单个查询（每行一个 ASIN，逐个查询）</label>
                <textarea id="asin-dl-single-input" rows="6" placeholder="一行一个 ASIN&#10;B08XXX&#10;B09YYY&#10;B07ZZZ" style="width:100%;padding:8px;border:1px solid #d9d9d9;border-radius:4px;font-size:12px;font-family:monospace;resize:vertical;box-sizing:border-box;"></textarea>
            </div>
            <div id="asin-dl-status" style="font-size:12px;color:#1890ff;margin-bottom:8px;min-height:18px;"></div>
            <div id="asin-dl-progress" style="margin-bottom:10px;">
                <div id="asin-dl-progress-bar" style="height:4px;background:#f0f0f0;border-radius:2px;overflow:hidden;">
                    <div id="asin-dl-progress-fill" style="height:100%;width:0%;background:#1890ff;transition:width 0.3s;"></div>
                </div>
                <div id="asin-dl-progress-text" style="font-size:11px;color:#999;margin-top:4px;"></div>
            </div>
            <div id="asin-dl-log" style="max-height:120px;overflow-y:auto;font-size:11px;color:#666;border:1px solid #f0f0f0;border-radius:4px;padding:6px;margin-bottom:10px;display:none;font-family:monospace;"></div>
            <div style="display:flex;gap:6px;">
                <button id="asin-dl-start" style="flex:1;padding:8px;cursor:pointer;background:#1890ff;color:#fff;border:none;border-radius:4px;font-size:13px;font-weight:bold;">开始运行</button>
                <button id="asin-dl-pause" style="flex:1;padding:8px;cursor:pointer;background:#faad14;color:#fff;border:none;border-radius:4px;font-size:13px;display:none;">暂停</button>
                <button id="asin-dl-stop" style="padding:8px 12px;cursor:pointer;background:#ff4d4f;color:#fff;border:none;border-radius:4px;font-size:13px;display:none;">停止</button>
            </div>
            <div style="margin-top:8px;text-align:right;">
                <button id="asin-dl-collapse" style="background:none;border:none;color:#999;cursor:pointer;font-size:11px;">收起 ▲</button>
            </div>
        `;
        panel.style.cssText = 'position:fixed;top:80px;right:0;z-index:99999;background:#fff;border:1px solid #d9d9d9;border-right:none;border-radius:8px 0 0 8px;padding:16px;box-shadow:-4px 0 12px rgba(0,0,0,0.1);font-family:-apple-system,sans-serif;font-size:13px;width:260px;transition:all 0.3s ease;';
        document.body.appendChild(panel);

        const expandBtn = document.createElement('div');
        expandBtn.id = 'asin-dl-expand-btn';
        expandBtn.textContent = '▼ ASIN DL';
        expandBtn.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;background:#1890ff;color:#fff;padding:4px 12px;border-radius:0 0 0 6px;font-size:11px;cursor:pointer;font-family:-apple-system,sans-serif;display:none;box-shadow:-2px 2px 6px rgba(0,0,0,0.15);';
        document.body.appendChild(expandBtn);

        document.getElementById('asin-dl-collapse').addEventListener('click', () => {
            panel.style.display = 'none';
            expandBtn.style.display = 'block';
        });

        expandBtn.addEventListener('click', () => {
            panel.style.display = 'block';
            expandBtn.style.display = 'none';
        });

        document.getElementById('asin-dl-start').addEventListener('click', startProcess);
        document.getElementById('asin-dl-pause').addEventListener('click', togglePause);
        document.getElementById('asin-dl-stop').addEventListener('click', stopProcess);
    }

    function updateStatus(text) {
        document.getElementById('asin-dl-status').textContent = text;
    }

    function updateProgress() {
        const total = asinGroups.length;
        const pct = total > 0 ? Math.round((currentIndex / total) * 100) : 0;
        document.getElementById('asin-dl-progress-fill').style.width = pct + '%';
        document.getElementById('asin-dl-progress-text').textContent = total > 0 ? `${currentIndex} / ${total} 完成` : '';
    }

    function addLog(msg) {
        const logEl = document.getElementById('asin-dl-log');
        logEl.style.display = 'block';
        const line = document.createElement('div');
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function readCurrentFilters() {
        const info = { region: '未检测到', marketplace: '未检测到', languageCode: '未检测到' };

        function findFilterValue(labelText) {
            const allLabels = document.querySelectorAll('span, div, label');
            for (const el of allLabels) {
                if (el.childElementCount > 1) continue;
                const t = el.textContent.trim();
                if (t === labelText || t === labelText + '*') {
                    let parent = el.parentElement;
                    for (let i = 0; i < 6; i++) {
                        if (!parent) break;
                        const tags = parent.querySelectorAll('.ant-select-selection-item [title], .ant-select-selection-item');
                        if (tags.length > 0) {
                            const vals = [];
                            tags.forEach(tag => {
                                const title = tag.getAttribute('title');
                                if (title) vals.push(title);
                                else {
                                    const content = tag.querySelector('[title]');
                                    if (content) vals.push(content.getAttribute('title'));
                                    else {
                                        const txt = tag.textContent.replace(/×/g, '').trim();
                                        if (txt) vals.push(txt);
                                    }
                                }
                            });
                            const unique = [...new Set(vals)].filter(v => v.length > 0);
                            if (unique.length > 0) return unique.join(', ');
                        }
                        parent = parent.parentElement;
                    }
                }
            }
            return null;
        }

        info.region = findFilterValue('Region') || info.region;
        info.marketplace = findFilterValue('Marketplace') || info.marketplace;
        info.languageCode = findFilterValue('Language Code') || info.languageCode;
        return info;
    }

    function showConfirmDialog(filterInfo, groupCount, singleCount, exportFmt) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:999999;display:flex;align-items:center;justify-content:center;';

            overlay.innerHTML = `
                <div style="background:#fff;border-radius:8px;padding:24px 28px;max-width:380px;width:90%;box-shadow:0 8px 24px rgba(0,0,0,0.2);font-family:-apple-system,sans-serif;font-size:14px;">
                    <div style="font-size:16px;font-weight:bold;margin-bottom:16px;color:#333;">运行前确认</div>
                    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
                        <tr style="border-bottom:1px solid #f0f0f0;">
                            <td style="padding:8px 0;color:#888;width:110px;">Region</td>
                            <td style="padding:8px 0;color:#333;font-weight:500;">${filterInfo.region}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #f0f0f0;">
                            <td style="padding:8px 0;color:#888;">Marketplace</td>
                            <td style="padding:8px 0;color:#333;font-weight:500;">${filterInfo.marketplace}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #f0f0f0;">
                            <td style="padding:8px 0;color:#888;">Language Code</td>
                            <td style="padding:8px 0;color:#333;font-weight:500;">${filterInfo.languageCode}</td>
                        </tr>
                        <tr style="border-bottom:1px solid #f0f0f0;">
                            <td style="padding:8px 0;color:#888;">导出格式</td>
                            <td style="padding:8px 0;color:#333;font-weight:500;">${exportFmt.toUpperCase()}</td>
                        </tr>
                    </table>
                    <div style="background:#f6f8fa;border-radius:6px;padding:12px;margin-bottom:20px;">
                        <div style="font-size:13px;color:#666;margin-bottom:6px;font-weight:bold;">本次查询</div>
                        <div style="font-size:13px;color:#333;">${groupCount > 0 ? `分组查询: ${groupCount} 组` : ''}${groupCount > 0 && singleCount > 0 ? '<br>' : ''}${singleCount > 0 ? `单个查询: ${singleCount} 个` : ''}</div>
                    </div>
                    <div style="display:flex;gap:10px;justify-content:flex-end;">
                        <button id="asin-confirm-cancel" style="padding:8px 20px;border:1px solid #d9d9d9;background:#fff;border-radius:4px;cursor:pointer;font-size:13px;color:#666;">取消</button>
                        <button id="asin-confirm-ok" style="padding:8px 20px;border:none;background:#1890ff;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;font-weight:bold;">确认运行</button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            overlay.querySelector('#asin-confirm-ok').addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(true);
            });
            overlay.querySelector('#asin-confirm-cancel').addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(false);
            });
        });
    }

    async function startProcess() {
        exportFormat = document.getElementById('asin-dl-format').value;
        const groupInput = document.getElementById('asin-dl-group-input').value;
        const singleInput = document.getElementById('asin-dl-single-input').value;

        if ((!groupInput || !groupInput.trim()) && (!singleInput || !singleInput.trim())) {
            alert('请至少在一个输入框中填入 ASIN');
            return;
        }

        asinGroups = [];

        if (groupInput && groupInput.trim()) {
            const lines = groupInput.split(/\n/);
            let currentGroup = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.length === 0) {
                    if (currentGroup.length > 0) {
                        asinGroups.push(currentGroup);
                        currentGroup = [];
                    }
                } else {
                    const asins = trimmed.split(/[,\s\t]+/).filter(a => a.length > 0);
                    currentGroup.push(...asins);
                }
            }
            if (currentGroup.length > 0) asinGroups.push(currentGroup);
        }

        if (singleInput && singleInput.trim()) {
            const singleAsins = singleInput.trim().split(/[\n,\s\t]+/).filter(a => a.length > 0);
            for (const asin of singleAsins) {
                asinGroups.push([asin]);
            }
        }

        if (asinGroups.length === 0) { alert('未解析到有效 ASIN'); return; }

        const groupCount = asinGroups.filter(g => g.length > 1).length;
        const singleCount = asinGroups.filter(g => g.length === 1).length;
        const filterInfo = readCurrentFilters();

        const confirmed = await showConfirmDialog(filterInfo, groupCount, singleCount, exportFormat);
        if (!confirmed) return;

        currentIndex = 0;
        groupCounter = 0;
        failedGroups = [];
        isPaused = false;
        isStopped = false;

        document.getElementById('asin-dl-start').style.display = 'none';
        document.getElementById('asin-dl-pause').style.display = 'inline-block';
        document.getElementById('asin-dl-stop').style.display = 'inline-block';
        document.getElementById('asin-dl-group-input').disabled = true;
        document.getElementById('asin-dl-single-input').disabled = true;
        document.getElementById('asin-dl-format').disabled = true;
        document.getElementById('asin-dl-log').innerHTML = '';

        updateStatus(`开始处理 ${asinGroups.length} 组 (${exportFormat.toUpperCase()})`);
        addLog(`启动：共 ${asinGroups.length} 组${groupCount > 0 ? `（其中 ${groupCount} 组含多个 ASIN）` : ''}，格式 ${exportFormat.toUpperCase()}`);
        updateProgress();
        processNext();
    }

    function togglePause() {
        isPaused = !isPaused;
        const btn = document.getElementById('asin-dl-pause');
        btn.textContent = isPaused ? '继续' : '暂停';
        btn.style.background = isPaused ? '#52c41a' : '#faad14';
        updateStatus(isPaused ? '已暂停' : '继续处理...');
        addLog(isPaused ? '已暂停' : '继续');
        if (!isPaused) processNext();
    }

    function stopProcess() {
        isStopped = true;
        isPaused = false;
        document.getElementById('asin-dl-start').style.display = 'inline-block';
        document.getElementById('asin-dl-pause').style.display = 'none';
        document.getElementById('asin-dl-stop').style.display = 'none';
        document.getElementById('asin-dl-group-input').disabled = false;
        document.getElementById('asin-dl-single-input').disabled = false;
        document.getElementById('asin-dl-format').disabled = false;
        updateStatus(`已停止 (完成 ${currentIndex}/${asinGroups.length})`);
        addLog('已手动停止');
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    }

    // ===== ASIN Filter 相关 =====

    function findAsinFilterSection() {
        const labels = document.querySelectorAll('[class*="filter"] label, [class*="Filter"] label, .ant-form-item-label label');
        for (const label of labels) {
            if (label.textContent.trim().startsWith('ASIN')) {
                const section = label.closest('[class*="filter"], .ant-form-item, [class*="Filter"]');
                if (section && section.querySelector('.ant-select, input[type="text"], input[type="search"]')) {
                    return section;
                }
            }
        }
        const allText = document.querySelectorAll('span, div, label');
        for (const el of allText) {
            const text = el.textContent.trim();
            if (text === 'ASIN*' || text === 'ASIN' || text.startsWith('ASIN')) {
                let parent = el.parentElement;
                for (let i = 0; i < 8; i++) {
                    if (parent && parent.querySelector('.ant-select, input[type="text"], input[type="search"]')) {
                        return parent;
                    }
                    parent = parent?.parentElement;
                }
            }
        }
        return null;
    }

    function clearExistingAsin() {
        const section = findAsinFilterSection();
        if (!section) return;
        const removeButtons = section.querySelectorAll(
            '.ant-select-selection-item-remove, [class*="remove"], .anticon-close, svg[class*="close"], [aria-label="close"]'
        );
        removeButtons.forEach(btn => {
            const clickable = btn.closest('span, button, div');
            if (clickable) clickable.click(); else btn.click();
        });
    }

    function setReactInputValue(input, value) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const tracker = input._valueTracker;
        if (tracker) {
            tracker.setValue('__force_different__');
        }
        nativeSetter.call(input, value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }

    function getKeywordsTableContent() {
        const chart = findMetricsByKeywordsChart();
        if (!chart) return '';
        const table = chart.querySelector('table, [role="table"], [role="grid"]');
        if (!table) return '';
        return table.textContent.trim().substring(0, 200);
    }

    async function inputAsinAndVerify(asin) {
        const section = findAsinFilterSection();
        if (!section) throw new Error('找不到 ASIN 筛选区域');

        const selectContainer = section.querySelector('.ant-select') || section.querySelector('[class*="select"]');
        const input = section.querySelector('input[type="text"], input[type="search"], .ant-select input, input');
        if (!input) throw new Error('找不到 ASIN 输入框');

        // 记录当前 keywords 表格内容，用于后面验证是否更新
        const beforeContent = getKeywordsTableContent();

        // === 快速路径：直接输入 + Enter ===
        if (selectContainer) { selectContainer.click(); await delay(400); }
        input.focus();
        await delay(200);
        setReactInputValue(input, '');
        await delay(100);
        setReactInputValue(input, asin);
        await delay(500);

        // 按 Enter 尝试直接确认
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        await delay(800);

        // 检查是否生成了 tag（说明 Enter 成功了）
        const tags = section.querySelectorAll('.ant-select-selection-item, [class*="tag"], [class*="Tag"]');
        const hasTag = Array.from(tags).some(t => t.textContent.includes(asin));

        if (hasTag) {
            addLog(`快速输入成功 (Enter): ${asin}`);
            return;
        }

        // 检查有没有 Select All 下拉框出现
        let selected = await findAndClickSelectAll();
        if (selected) {
            addLog(`快速输入成功 (Select All): ${asin}`);
            await delay(400);
            return;
        }

        // === 快速路径失败，尝试 Apply 看是否实际生效了 ===
        addLog(`无 tag/下拉框，尝试 Apply 验证: ${asin}`);
        clickApplyFilters();
        await delay(5000);

        const afterContent = getKeywordsTableContent();
        if (afterContent !== beforeContent && afterContent.length > 0) {
            addLog(`Apply 后数据已更新，ASIN 生效: ${asin}`);
            return;
        }

        // === 数据没更新，进入重试模式 ===
        addLog(`数据未更新，重试输入: ${asin}`);

        // 清除可能残留的内容
        clearExistingAsin();
        await delay(400);

        // 重试1: execCommand
        if (selectContainer) { selectContainer.click(); await delay(400); }
        input.focus();
        await delay(200);
        input.select();
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
        await delay(200);
        document.execCommand('insertText', false, asin);
        await delay(1500);

        selected = await findAndClickSelectAll();
        if (selected) {
            addLog(`重试成功 (execCommand + Select All): ${asin}`);
            await delay(400);
            return;
        }

        // 重试2: 逐字符输入
        addLog(`execCommand 失败，逐字符输入: ${asin}`);
        input.focus();
        await delay(200);
        setReactInputValue(input, '');
        await delay(200);

        for (let i = 0; i < asin.length; i++) {
            const char = asin[i];
            input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            setReactInputValue(input, asin.substring(0, i + 1));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
            await delay(50);
        }
        await delay(1500);

        selected = await findAndClickSelectAll();
        if (selected) {
            addLog(`逐字符输入成功: ${asin}`);
            await delay(400);
        } else {
            addLog(`所有方式均失败，强制 Enter: ${asin}`);
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            await delay(800);
        }
    }

    function getTagCount(section) {
        const items = section.querySelectorAll('.ant-select-selection-item');
        let count = 0;
        for (const item of items) {
            const text = item.textContent.trim();
            // "+5 ..." 这种折叠标签表示隐藏了5个，解析出来
            const overflowMatch = text.match(/^\+\s*(\d+)/);
            if (overflowMatch) {
                count += parseInt(overflowMatch[1]);
            } else if (text && text !== '×') {
                count++;
            }
        }
        return count;
    }

    async function inputAsinGroup(asinArray) {
        const section = findAsinFilterSection();
        if (!section) throw new Error('找不到 ASIN 筛选区域');

        addLog(`  逐个输入 ${asinArray.length} 个 ASIN...`);

        for (let i = 0; i < asinArray.length; i++) {
            const asin = asinArray[i];
            const countBefore = getTagCount(section);

            // 打开下拉框
            const sc = section.querySelector('.ant-select') || section.querySelector('[class*="select"]');
            if (sc) { sc.click(); await delay(300); }

            // 获取 input
            let inp = section.querySelector('input[type="search"]') ||
                      section.querySelector('input[type="text"]') ||
                      section.querySelector('.ant-select input') ||
                      section.querySelector('input');
            if (!inp) throw new Error(`找不到 ASIN 输入框 (第 ${i + 1} 个)`);

            inp.focus();
            await delay(150);
            setReactInputValue(inp, '');
            await delay(100);
            setReactInputValue(inp, asin);
            await delay(500);

            // Enter 确认
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            await delay(600);

            // 通过 tag 数量增加来判断是否成功（不依赖文本匹配）
            const countAfter = getTagCount(section);
            if (countAfter > countBefore) {
                addLog(`  输入 ${i + 1}/${asinArray.length}: ${asin} ✓`);
                continue;
            }

            // 数量没增加，尝试点击下拉选项
            const selected = await findAndClickDropdownOption(asin);
            if (selected) {
                await delay(300);
                addLog(`  输入 ${i + 1}/${asinArray.length}: ${asin} ✓ (下拉)`);
                continue;
            }

            // 最后尝试 Select All
            const selectedAll = await findAndClickSelectAll();
            if (selectedAll) {
                await delay(300);
                addLog(`  输入 ${i + 1}/${asinArray.length}: ${asin} ✓ (Select All)`);
                continue;
            }

            addLog(`  ⚠ ${asin} 可能未成功输入`);
        }

        addLog(`  输入完成: 共 ${getTagCount(section)} 个 tag`);
    }

    async function findAndClickDropdownOption(asin) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const options = document.querySelectorAll('.ant-select-item-option, [role="option"]');
            for (const opt of options) {
                if (!isElementVisible(opt)) continue;
                const title = opt.getAttribute('title') || opt.textContent.trim();
                if (title === asin) {
                    opt.click();
                    return true;
                }
            }
            await delay(300);
        }
        return false;
    }

    async function findAndClickSelectAll() {
        for (let attempt = 0; attempt < 8; attempt++) {
            const allElements = document.querySelectorAll('span, div, a, button, li');
            for (const el of allElements) {
                if (!isElementVisible(el)) continue;
                const text = el.textContent.trim();
                if (text.startsWith('Select All') && el.childElementCount <= 1) {
                    el.click();
                    return true;
                }
            }
            await delay(400);
        }
        return false;
    }

    // ===== Apply Filters =====

    function clickApplyFilters() {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
            if (btn.textContent.trim().toUpperCase().includes('APPLY FILTER')) {
                btn.click();
                return true;
            }
        }
        return false;
    }

    // ===== 等待数据加载 =====

    async function waitForDataLoad() {
        await delay(3000);
        const maxWait = 30000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const chartArea = findMetricsByKeywordsChart();
            if (chartArea) {
                const hasLoading = chartArea.querySelector('.loading, [class*="loading"], [class*="Loading"], .ant-spin-spinning, [class*="spinner"]');
                if (!hasLoading) {
                    const table = chartArea.querySelector('table, [class*="table"], [role="table"], [role="grid"]');
                    if (table) return true;
                }
            }
            const globalLoading = document.querySelectorAll('.ant-spin-spinning, [class*="loading"]');
            let anyVisible = false;
            for (const l of globalLoading) {
                if (l.offsetParent !== null) { anyVisible = true; break; }
            }
            if (!anyVisible && Date.now() - start > 8000) return true;
            await delay(1000);
        }
        return true;
    }

    // ===== 图表定位 =====

    function findMetricsByKeywordsChart() {
        const allElements = document.querySelectorAll('span, div, h1, h2, h3, h4, header');
        for (const el of allElements) {
            if (el.childElementCount === 0 && el.textContent.trim() === 'Metrics by Keywords') {
                let parent = el.parentElement;
                for (let i = 0; i < 10; i++) {
                    if (!parent) break;
                    const cls = parent.getAttribute('class') || '';
                    if (cls.includes('chart') || cls.includes('Chart') || cls.includes('slice') || cls.includes('Slice')) {
                        return parent;
                    }
                    const hasThreeDots = parent.querySelector('svg[viewBox], [class*="vertical"], [class*="ellipsis"], [class*="dot"]');
                    if (hasThreeDots && parent.querySelector('table, [role="table"], [role="grid"]')) {
                        return parent;
                    }
                    parent = parent.parentElement;
                }
                let fallback = el.parentElement;
                for (let i = 0; i < 5; i++) {
                    if (!fallback) break;
                    fallback = fallback.parentElement;
                }
                return fallback || el.parentElement?.parentElement?.parentElement?.parentElement;
            }
        }
        return null;
    }

    function findClickableMenuButton(container) {
        const candidates = container.querySelectorAll('span, button, div, i, a');
        for (const el of candidates) {
            const cls = (el.getAttribute('class') || '').toLowerCase();
            const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
            if (cls.includes('kebab') || cls.includes('dot') || cls.includes('ellipsis') ||
                cls.includes('vertical') || ariaLabel.includes('more') || ariaLabel.includes('menu')) {
                if (typeof el.click === 'function') return el;
            }
        }
        const svgs = container.querySelectorAll('svg');
        for (const svg of svgs) {
            const parent = svg.parentElement;
            if (parent && typeof parent.click === 'function') {
                const rect = parent.getBoundingClientRect();
                if (rect.width < 40 && rect.height < 40 && rect.width > 0) {
                    return parent;
                }
            }
        }
        const buttons = container.querySelectorAll('button');
        if (buttons.length > 0) return buttons[buttons.length - 1];
        return null;
    }

    // ===== 下载逻辑 =====

    function findVisibleElementByText(searchText, exact = false) {
        const all = document.querySelectorAll('*');
        for (const el of all) {
            if (!isElementVisible(el)) continue;
            const text = el.textContent.trim();
            const match = exact ? (text === searchText) : text.includes(searchText);
            if (match && (el.childElementCount === 0 || el.childElementCount <= 1)) {
                return el;
            }
        }
        for (const el of all) {
            if (!isElementVisible(el)) continue;
            const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
            const match = exact ? (directText === searchText) : directText.includes(searchText);
            if (match && directText.length > 0) return el;
        }
        return null;
    }

    function forceShowHiddenMenus() {
        const allDivs = document.querySelectorAll('body > div[style*="position"]');
        allDivs.forEach(div => {
            const style = div.getAttribute('style') || '';
            if (style.includes('visibility: hidden') || style.includes('visibility:hidden')) {
                const hasExport = div.textContent.includes('Export to') || div.textContent.includes('Download');
                if (hasExport) {
                    div.style.visibility = 'visible';
                    div.style.opacity = '1';
                    div.style.pointerEvents = 'auto';
                    const hiddenChildren = div.querySelectorAll('[style*="visibility: hidden"], [style*="visibility:hidden"]');
                    hiddenChildren.forEach(child => {
                        child.style.visibility = 'visible';
                        child.style.opacity = '1';
                    });
                }
            }
        });
    }

    function findElementByTextInAll(searchText, exact = false) {
        const all = document.querySelectorAll('*');
        for (const el of all) {
            const text = el.textContent.trim();
            const match = exact ? (text === searchText) : text.includes(searchText);
            if (match && el.childElementCount === 0) {
                return el;
            }
        }
        for (const el of all) {
            const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
            if (directText.length === 0) continue;
            const match = exact ? (directText === searchText) : directText.includes(searchText);
            if (match) return el;
        }
        return null;
    }

    async function triggerDownload() {
        const chartContainer = findMetricsByKeywordsChart();
        if (!chartContainer) throw new Error('找不到 Metrics by Keywords 图表区域');

        const menuButton = findClickableMenuButton(chartContainer);
        if (!menuButton) throw new Error('找不到图表菜单按钮（三个点）');

        menuButton.click();
        await delay(1500);

        addLog('菜单已打开，强制显示隐藏子菜单...');
        forceShowHiddenMenus();
        await delay(500);
        forceShowHiddenMenus();
        await delay(500);

        const targetText = exportFormat === 'csv' ? 'Export to .CSV' : 'Export to Excel';
        let exportItem = findElementByTextInAll(targetText, true);

        if (!exportItem) {
            addLog('直接查找失败，尝试点击 Download 后再找...');
            let downloadEl = findVisibleElementByText('Download');
            if (downloadEl) {
                downloadEl.click();
                await delay(800);
                forceShowHiddenMenus();
                await delay(500);
                exportItem = findElementByTextInAll(targetText, true);
            }
        }

        if (!exportItem) {
            const fallback = exportFormat === 'csv' ? 'CSV' : 'Excel';
            exportItem = findElementByTextInAll(fallback);
            if (exportItem && exportItem.textContent.includes('image')) exportItem = null;
        }

        if (!exportItem) throw new Error(`找不到 "${targetText}" 选项`);

        addLog(`找到 ${targetText}，点击下载...`);
        exportItem.click();
        await delay(3000);
    }

    // ===== 主循环 =====

    function hasTableData() {
        const chart = findMetricsByKeywordsChart();
        if (!chart) return false;
        const table = chart.querySelector('table, [role="table"], [role="grid"]');
        if (!table) return false;
        const rows = table.querySelectorAll('tbody tr, [role="row"]');
        return rows.length > 1;
    }

    function getGroupLabel(index, group) {
        if (group.length === 1) return group[0];
        return `第 ${index + 1} 组 (${group.join(', ')})`;
    }

    async function processNext() {
        if (isStopped || currentIndex >= asinGroups.length) {
            if (!isStopped) {
                document.getElementById('asin-dl-start').style.display = 'inline-block';
                document.getElementById('asin-dl-pause').style.display = 'none';
                document.getElementById('asin-dl-stop').style.display = 'none';
                document.getElementById('asin-dl-group-input').disabled = false;
                document.getElementById('asin-dl-single-input').disabled = false;
                document.getElementById('asin-dl-format').disabled = false;
                updateProgress();

                if (failedGroups.length > 0) {
                    const failList = failedGroups.map(f => `  - ${f.label}: ${f.reason}`).join('\n');
                    updateStatus(`完成！${failedGroups.length} 组失败`);
                    addLog(`=== 完成，${failedGroups.length} 组下载失败 ===`);
                    failedGroups.forEach(f => addLog(`  ✗ ${f.label}: ${f.reason}`));
                    alert(`处理完成！\n\n以下 ${failedGroups.length} 组未成功下载：\n${failList}`);
                } else {
                    updateStatus(`全部完成！共处理 ${asinGroups.length} 组`);
                    addLog('全部完成！');
                }
            }
            return;
        }

        if (isPaused) return;

        const group = asinGroups[currentIndex];
        const isSingle = group.length === 1;
        const groupLabel = getGroupLabel(currentIndex, group);

        if (isSingle) {
            currentAsin = group[0];
            updateStatus(`[${currentIndex + 1}/${asinGroups.length}] 处理: ${currentAsin}`);
        } else {
            groupCounter++;
            currentAsin = `group_${groupCounter}`;
            updateStatus(`[${currentIndex + 1}/${asinGroups.length}] 处理第 ${groupCounter} 组 (${group.length} 个 ASIN)`);
        }

        try {
            addLog(`清除旧 ASIN...`);
            clearExistingAsin();
            await delay(600);

            if (isSingle) {
                addLog(`输入 ${group[0]}...`);
                await inputAsinAndVerify(group[0]);
            } else {
                addLog(`输入第 ${groupCounter} 组 (${group.length} 个 ASIN)...`);
                await inputAsinGroup(group);
            }
            await delay(400);

            addLog(`点击 Apply Filters...`);
            clickApplyFilters();

            addLog(`等待数据加载...`);
            await waitForDataLoad();

            if (!hasTableData()) {
                addLog(`✗ ${groupLabel} 表格无数据，跳过下载`);
                failedGroups.push({ label: groupLabel, reason: '表格无数据' });
                currentIndex++;
                updateProgress();
                if (currentIndex < asinGroups.length) {
                    await delay(2000);
                    processNext();
                } else {
                    processNext();
                }
                return;
            }

            addLog(`触发下载...`);
            await triggerDownload();

            addLog(`✓ ${currentAsin} 完成`);
            currentIndex++;
            updateProgress();

            if (currentIndex < asinGroups.length) {
                updateStatus(`等待 2 秒后处理下一个...`);
                await delay(2000);
                processNext();
            } else {
                processNext();
            }
        } catch (err) {
            addLog(`✗ ${groupLabel} 出错: ${err.message}`);
            failedGroups.push({ label: groupLabel, reason: err.message });
            currentIndex++;
            updateProgress();
            if (currentIndex < asinGroups.length) {
                await delay(2000);
                processNext();
            } else {
                processNext();
            }
        }
    }

    function init() {
        if (document.getElementById('asin-downloader-panel')) return;
        hookDownloadRename();
        setupLinkObserver();
        createPanel();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(init, 3000));
    } else {
        setTimeout(init, 3000);
    }
})();
