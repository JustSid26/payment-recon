import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { getToken, getUser } from './lib/api'
import Layout from './components/Layout'
import { Toaster } from './components/ui'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Merchants from './pages/Merchants'
import MerchantDetailPage from './pages/MerchantDetail'
import Transactions from './pages/Transactions'
import TransactionDetailPage from './pages/TransactionDetail'
import Settlements from './pages/Settlements'
import SettlementDetailPage from './pages/SettlementDetail'
import Ledger from './pages/Ledger'
import LedgerMerchant from './pages/LedgerMerchant'
import LedgerAccountPage from './pages/LedgerAccount'
import Integrity from './pages/Integrity'
import Reserve from './pages/Reserve'
import RollingReserve from './pages/RollingReserve'
import Upload from './pages/Upload'
import Settings from './pages/Settings'
import Insights from './pages/Insights'

function RequireAuth({ children }: { children: React.ReactElement }) {
  const location = useLocation()
  if (!getToken() || !getUser()) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}

function AdminOnly({ children }: { children: React.ReactElement }) {
  return getUser()?.role === 'admin' ? children : <Navigate to="/" replace />
}

function MerchantOnly({ children }: { children: React.ReactElement }) {
  return getUser()?.role === 'merchant' ? children : <Navigate to="/" replace />
}

/** A merchant IS a fixed merchant — skip the "pick a merchant" ledger list and
 *  land them straight on their own ledger. Admins get the full list. */
function LedgerRoute() {
  const user = getUser()
  if (user?.role === 'merchant' && user.merchant_uuid) {
    return <Navigate to={`/ledger/merchants/${user.merchant_uuid}`} replace />
  }
  return <Ledger />
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route
            path="/upload"
            element={
              <AdminOnly>
                <Upload />
              </AdminOnly>
            }
          />
          <Route
            path="/merchants"
            element={
              <AdminOnly>
                <Merchants />
              </AdminOnly>
            }
          />
          <Route
            path="/merchants/:uuid"
            element={
              <AdminOnly>
                <MerchantDetailPage />
              </AdminOnly>
            }
          />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/transactions/:uuid" element={<TransactionDetailPage />} />
          <Route path="/settlements" element={<Settlements />} />
          <Route path="/settlements/:uuid" element={<SettlementDetailPage />} />
          <Route path="/insights" element={<Insights />} />
          <Route
            path="/rolling-reserve"
            element={
              <AdminOnly>
                <RollingReserve />
              </AdminOnly>
            }
          />
          <Route
            path="/rolling-reserve/:uuid"
            element={
              <AdminOnly>
                <RollingReserve />
              </AdminOnly>
            }
          />
          <Route path="/ledger" element={<LedgerRoute />} />
          <Route path="/ledger/merchants/:uuid" element={<LedgerMerchant />} />
          <Route path="/ledger/accounts/:id" element={<LedgerAccountPage />} />
          <Route
            path="/integrity"
            element={
              <AdminOnly>
                <Integrity />
              </AdminOnly>
            }
          />
          <Route
            path="/reserve"
            element={
              <MerchantOnly>
                <Reserve />
              </MerchantOnly>
            }
          />
          <Route
            path="/settings"
            element={
              <AdminOnly>
                <Settings />
              </AdminOnly>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}
