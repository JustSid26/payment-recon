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
import LedgerAccountPage from './pages/LedgerAccount'
import Integrity from './pages/Integrity'
import Reserve from './pages/Reserve'
import Upload from './pages/Upload'

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
          <Route path="/ledger" element={<Ledger />} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}
