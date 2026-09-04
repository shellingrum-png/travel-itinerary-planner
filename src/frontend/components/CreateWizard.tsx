import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWizardStore } from '../stores/wizardStore';
import type { TripTemplate } from '../types';

/**
 * V6.0 三步创建向导:① 城市/天数 → ② 城际晚数 → ③ 模板匹配
 */
export default function CreateWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const store = useWizardStore();
  const [cityInput, setCityInput] = useState('');
  const [title, setTitle] = useState('');
  const [companions, setCompanions] = useState(2);

  const totalDays = store.startDate && store.endDate
    ? (new Date(store.endDate).getTime() - new Date(store.startDate).getTime()) / 86400000 + 1
    : 0;

  const addCity = () => {
    const city = cityInput.trim();
    if (!city || store.cities.includes(city)) return;
    store.setCities([...store.cities, city]);
    setCityInput('');
  };

  const removeCity = (city: string) => {
    store.removeCity(city);
  };

  const renderStep1 = () => (
    <div>
      <h3 style={{ marginTop: 0, color: '#e0e0e0' }}>第一步 · 确定目的地与天数</h3>

      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>目的地（支持多城市，逗号分隔或逐个添加）</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={cityInput}
            onChange={(e) => setCityInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { addCity(); e.preventDefault(); } }}
            placeholder="如：西宁、张掖、敦煌"
            style={{ flex: 1, padding: 8, borderRadius: 6, border: '1px solid #444', background: '#222', color: '#eee' }}
          />
          <button onClick={addCity} style={btnStyle}>添加</button>
        </div>
        {store.cities.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {store.cities.map((c) => (
              <span key={c} style={{ background: 'rgba(22,119,255,0.2)', border: '1px solid rgba(22,119,255,0.4)', borderRadius: 12, padding: '2px 10px', fontSize: 13, color: '#7ebaff' }}>
                {c} <button onClick={() => removeCity(c)} style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', marginLeft: 4 }}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>开始日期</label>
          <input type="date" value={store.startDate} onChange={(e) => store.setDates(e.target.value, store.endDate)} style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>结束日期</label>
          <input type="date" value={store.endDate} onChange={(e) => store.setDates(store.startDate, e.target.value)} style={inputStyle} />
        </div>
      </div>

      {totalDays > 0 && (
        <div style={{ fontSize: 13, color: '#06d6a0', marginBottom: 8 }}>
          共 <strong>{totalDays}</strong> 天 · {totalDays - 1} 晚
        </div>
      )}

      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>行程标题（可改）</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={store.cities.join(' · ') + ' 之旅'} style={inputStyle} />
      </div>

      {store.error && <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 8 }}>{store.error}</div>}
      <NextButton disabled={store.cities.length === 0 || !store.startDate || !store.endDate} />
    </div>
  );

  const renderStep2 = () => (
    <div>
      <h3 style={{ marginTop: 0, color: '#e0e0e0' }}>第二步 · 分配城际晚数</h3>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>
        总天数 <strong style={{ color: '#06d6a0' }}>{totalDays}</strong> · 需分配 <strong style={{ color: '#ffd166' }}>{totalDays - 1}</strong> 晚
      </div>

      {store.cities.map((city) => {
        const nights = store.nights[city] ?? 1;
        return (
          <div key={city} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <span style={{ fontSize: 14, color: '#ddd' }}>🏙️ {city}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => store.setNights(city, Math.max(0, nights - 1))} style={stepBtn}>−</button>
              <span style={{ fontSize: 16, color: '#ffd166', minWidth: 20, textAlign: 'center' }}>{nights}</span>
              <button onClick={() => store.setNights(city, Math.min(10, nights + 1))} style={stepBtn}>＋</button>
              <span style={{ fontSize: 12, color: '#888' }}>晚</span>
            </div>
          </div>
        );
      })}

      {store.error && <div style={{ color: '#ff6b6b', fontSize: 12, marginTop: 8 }}>{store.error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button onClick={store.back} style={btnStyle}>上一步</button>
        <button onClick={store.next} style={{ ...btnStyle, background: '#1677ff', flex: 2 }}>下一步 · 匹配模板</button>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div>
      <h3 style={{ marginTop: 0, color: '#e0e0e0' }}>第三步 · 智能模板匹配</h3>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>
        为你找到 <strong style={{ color: '#06d6a0' }}>{store.matchedTemplates.length}</strong> 个包含这些城市的经典行程
      </div>

      {store.matchedTemplates.length === 0 && (
        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.05)', marginBottom: 10, fontSize: 13, color: '#aaa' }}>
          暂无匹配模板，将创建空白行程（仅日程骨架，之后自行添加景点）。
        </div>
      )}

      {store.matchedTemplates.map((tpl: TripTemplate) => {
        const selected = store.selectedTemplateId === tpl.id;
        return (
          <div
            key={tpl.id}
            onClick={() => store.selectTemplate(tpl.id)}
            style={{
              padding: 12, borderRadius: 8, marginBottom: 8, cursor: 'pointer',
              border: selected ? '2px solid #1677ff' : '1px solid rgba(255,255,255,0.15)',
              background: selected ? 'rgba(22,119,255,0.12)' : 'rgba(255,255,255,0.04)',
            }}
          >
            <div style={{ color: '#ffd166', fontWeight: 600 }}>📋 {tpl.title}</div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              路线：{tpl.cities} · 共 {tpl.daysCount} 天
            </div>
          </div>
        );
      })}

      {/* 方案乙：空白行程 */}
      <div
        onClick={() => store.selectTemplate('')}
        style={{
          padding: 12, borderRadius: 8, marginBottom: 10, cursor: 'pointer',
          border: store.selectedTemplateId === '' ? '2px solid #06d6a0' : '1px solid rgba(255,255,255,0.15)',
          background: store.selectedTemplateId === '' ? 'rgba(6,214,160,0.12)' : 'rgba(255,255,255,0.04)',
        }}
      >
        <div style={{ color: '#06d6a0', fontWeight: 600 }}>🗒️ 方案乙 · 空白行程</div>
        <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>只生成每日骨架，之后自行搜索添加景点</div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>同行人数</label>
        <input type="number" min={1} value={companions} onChange={(e) => setCompanions(Math.max(1, +e.target.value))} style={inputStyle} />
      </div>

      {store.error && <div style={{ color: '#ff6b6b', fontSize: 12, marginBottom: 8 }}>{store.error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={store.back} style={btnStyle} disabled={store.creating}>上一步</button>
        <button
          onClick={async () => {
            const t = await store.create({
              title: title || (store.cities.join(' · ') + ' 之旅'),
              companionCount: companions,
              currency: 'CNY',
            });
            if (t) { onClose(); store.reset(); navigate(`/trip/${t.id}`); }
          }}
          style={{ ...btnStyle, background: store.selectedTemplateId ? '#06d6a0' : '#1677ff', flex: 2, color: store.selectedTemplateId ? '#001' : '#fff' }}
          disabled={store.creating}
        >
          {store.creating ? '创建中…' : store.selectedTemplateId ? '✅ 一键套用此模板' : '创建空白行程'}
        </button>
      </div>
    </div>
  );

  return (
    <div style={{
      border: '1px solid rgba(255,255,255,0.15)', borderRadius: 12,
      background: 'rgba(26,26,46,0.98)', padding: 20, margin: '16px 0',
      boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
    }}>
      {/* 步骤指示器 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        {[1, 2, 3].map((s) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{
              width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: store.step === s ? '#1677ff' : s < store.step ? '#06d6a0' : 'rgba(255,255,255,0.1)',
              color: s < store.step ? '#001' : '#fff', fontSize: 13, fontWeight: 700,
            }}>{s < store.step ? '✓' : s}</div>
            <div style={{ fontSize: 11, color: store.step === s ? '#eee' : '#777', marginLeft: 6, whiteSpace: 'nowrap' }}>
              {s === 1 ? '城市/天数' : s === 2 ? '城际晚数' : '模板匹配'}
            </div>
            {s < 3 && <div style={{ flex: 1, height: 2, background: 'rgba(255,255,255,0.1)', margin: '0 8px' }} />}
          </div>
        ))}
      </div>

      {store.step === 1 && renderStep1()}
      {store.step === 2 && renderStep2()}
      {store.step === 3 && renderStep3()}
    </div>
  );
}

// ── 样式常量 ──
const inputStyle: React.CSSProperties = {
  width: '100%', padding: 8, borderRadius: 6, border: '1px solid #444',
  background: '#222', color: '#eee', fontSize: 13, boxSizing: 'border-box',
};
const btnStyle: React.CSSProperties = {
  padding: '10px 16px', borderRadius: 6, border: 'none', cursor: 'pointer',
  background: 'rgba(255,255,255,0.1)', color: '#eee', fontSize: 13, fontWeight: 600,
};
const stepBtn: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 6, border: '1px solid #444',
  background: '#222', color: '#fff', cursor: 'pointer', fontSize: 16,
};
const NextButton = ({ disabled }: { disabled?: boolean }) => (
  <div style={{ display: 'flex', gap: 8 }}>
    <button onClick={() => useWizardStore.getState().next()} disabled={disabled} style={{ ...btnStyle, background: '#1677ff', flex: 2, opacity: disabled ? 0.4 : 1 }}>
      下一步 · 分配晚数
    </button>
  </div>
);