import type { ComponentType, ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Option from './_define/Option';
import Home from './screens/Home';
import DocumentList from './screens/DocumentList';
import DocumentDetail from './screens/DocumentDetail';

const framed = (page: ReactNode) => <main className="frame">{page}</main>;

function Signed({ Page }: { Page: ComponentType }) {
  return <Page />;
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path={Option.ROUTE_PATH.HOME as string} element={<Home />} />
      <Route path={Option.ROUTE_PATH.DOCUMENT} element={framed(<DocumentList />)} />
      <Route path={`${Option.ROUTE_PATH.DOCUMENT!}/:id`} element={<Signed Page={DocumentDetail} />} />
      <Route path="*" element={<Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />} />
    </Routes>
  );
}
