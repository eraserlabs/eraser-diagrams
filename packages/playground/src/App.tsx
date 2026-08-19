import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Playground } from './pages/Playground.js';
import { ApiReference } from './pages/ApiReference.js';
import './styles/global.scss';

const tabClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'tab active' : 'tab');

export function App() {
  return (
    <div className="app">
      <header className="app__header">
        <h1>eraser-diagrams</h1>
        <nav>
          <NavLink to="/" end className={tabClass}>
            Playground
          </NavLink>
          <NavLink to="/reference" className={tabClass}>
            API reference
          </NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Playground />} />
        <Route path="/reference" element={<Navigate to="/reference/elements" replace />} />
        <Route path="/reference/:section" element={<ApiReference />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
