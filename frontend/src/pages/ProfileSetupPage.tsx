import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { MeResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ProfileForm } from '../components/ProfileForm';

/** 가입 직후 프로필 입력 (목표 칼로리 계산에 필요) */
export function ProfileSetupPage() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  return (
    <main className="app no-nav">
      <div className="page-header">
        <h1>{me?.user.nickname}님, 반가워요!</h1>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        목표 칼로리를 계산하기 위해 몇 가지 정보가 필요해요. 언제든 프로필에서 바꿀 수 있어요.
      </p>
      <div className="card">
        <ProfileForm
          submitLabel="시작하기"
          onSubmit={async (v) => {
            try {
              const r = await api<MeResponse>('/me/profile', { method: 'PUT', body: v });
              setMe(r);
              navigate('/', { replace: true });
            } catch (e) {
              throw new Error(errorMessage(e));
            }
          }}
        />
      </div>
    </main>
  );
}
