import { Route, Routes } from 'react-router-dom';
import Option from '../_define/Option';
import { LazyPage } from './lazyPages';

const { Archive } = LazyPage;

export default function PageRoutes() {
  return (
    <Routes>
      <Route path={Option.ROUTE_PATH.ARCHIVE} element={<Archive />} />
      <Route path={Option.ROUTE_PATH.PROFILE} element={<LazyPage.Profile />} />
    </Routes>
  );
}
