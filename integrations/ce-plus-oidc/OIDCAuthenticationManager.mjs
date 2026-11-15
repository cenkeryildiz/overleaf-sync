// SPDX-License-Identifier: AGPL-3.0-only
// CE+ authors: Overleaf, yu-i-i and davrot; modified by Cenker YILDIZ, 2026-11-15.
import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import UserCreator from '../../../../../app/src/Features/User/UserCreator.mjs'
import ThirdPartyIdentityManager from '../../../../../app/src/Features/User/ThirdPartyIdentityManager.mjs'
import { ParallelLoginError } from '../../../../../app/src/Features/Authentication/AuthenticationErrors.mjs'
import { User } from '../../../../../app/src/models/User.mjs'
import Errors from '../../../../../app/src/Features/Errors/Errors.js'

function verifiedIdentity(profile) {
  const email = profile?.emails?.[0]?.value
  const oidcUserId = profile?.id
  if (Settings.oidc.attUserId !== 'id') {
    throw new Error('OIDC must use the provider subject as user ID')
  }
  if (
    typeof email !== 'string' || !email.includes('@') ||
    typeof oidcUserId !== 'string' || !oidcUserId ||
    profile?._json?.email_verified !== true ||
    profile._json.email !== email || profile._json.sub !== oidcUserId
  ) {
    throw Object.assign(new Error('OIDC requires a verified email and consistent subject'), { status: 403 })
  }
  return { email, oidcUserId }
}

const OIDCAuthenticationManager = {
  async findOrCreateUser(profile, auditLog) {
    const {
      attAdmin,
      valAdmin,
      updateUserDetailsOnLogin,
      providerId,
    } = Settings.oidc
    const { email, oidcUserId } = verifiedIdentity(profile)
    const firstName = profile.name?.givenName || ""
    const lastName  = profile.name?.familyName || ""
    let isAdmin = false
    if (attAdmin && valAdmin) {
      if (attAdmin === 'email') {
        isAdmin = (email === valAdmin)
      } else {
        const adminClaim = profile[attAdmin] || profile._json?.[attAdmin]
        isAdmin = (adminClaim === valAdmin)
      }
    }
    const oidcUserData = null // Possibly it can be used later
    let user
    try {
      user = await ThirdPartyIdentityManager.promises.login(providerId, oidcUserId, oidcUserData)
      if (!user.thirdPartyIdentifiers?.some(identity => identity.providerId === providerId && identity.externalUserId === oidcUserId)) {
        throw Object.assign(new Error('OIDC linked identity does not match the provider subject'), { status: 403 })
      }
    } catch (error) {
      if (!(error instanceof Errors.ThirdPartyUserNotFoundError)) throw error
      user = await User.findOne({ 'email': email }).exec()
      if (user?.thirdPartyIdentifiers?.some(identity => identity.providerId === providerId)) {
        throw Object.assign(new Error('Account is already linked to this provider'), { status: 409 })
      }
      if (!user) {
        const allowedDomains = Settings.oidc.allowedOIDCEmailDomains
        if (
          allowedDomains &&
          !allowedDomains.some(pattern => {
            const domain = email.split('@')[1]
            if (pattern.startsWith('*.')) {
              const base = pattern.slice(2)
              return domain.endsWith(`.${base}`)
            }
            return domain === pattern
          })
        ) {
          return null
        }
        user = await UserCreator.promises.createNewUser(
          {
            email: email,
            first_name: firstName,
            last_name: lastName,
            isAdmin: isAdmin,
            holdingAccount: false,
            analyticsId: crypto.randomUUID(),
          }
        )
      }
        auditLog.initiatorId = user._id
        // The native retry flag prevents unlink/replacement if another link wins a race.
        await ThirdPartyIdentityManager.promises.link(user._id, providerId, oidcUserId, oidcUserData, auditLog, true)
        await User.updateOne(
          { _id: user._id },
          { $set : {
             'emails.0.confirmedAt': Date.now(), //email of external user is confirmed
            },
          }
        ).exec()
    }

    let userDetails = updateUserDetailsOnLogin ? { first_name : firstName, last_name: lastName } : {}
    if (attAdmin && valAdmin) {
      user.isAdmin = isAdmin
      userDetails.isAdmin = isAdmin
    }
    const result = await User.updateOne(
      { _id: user._id, loginEpoch: user.loginEpoch }, { $inc: { loginEpoch: 1 }, $set: userDetails },
      {}
    ).exec()

    if (result.modifiedCount !== 1) {
      throw new ParallelLoginError()
    }
    return user
  },
  async linkAccount(userId, profile, auditLog) {
    const { providerId } = Settings.oidc
    const { oidcUserId } = verifiedIdentity(profile)
    const oidcUserData = null // Possibly it can be used later
    await ThirdPartyIdentityManager.promises.link(userId, providerId, oidcUserId, oidcUserData, auditLog, true)
  },
}

export default {
  promises: OIDCAuthenticationManager,
}
