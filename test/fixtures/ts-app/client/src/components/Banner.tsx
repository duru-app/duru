import { Link } from 'react-router-dom';
import Option from '../_define/Option';

export type BannerProps = { title: string };

export function Banner({ title }: BannerProps) {
  return <Link to={Option.ROUTE_PATH.LAB}>{title}</Link>;
}
